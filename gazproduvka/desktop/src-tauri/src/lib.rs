//! ГазПродувка — локальный backend настольного приложения.
//!
//! Прямое подключение к PostgreSQL по TCP (tokio-postgres + native-tls / SChannel),
//! без шлюзов и промежуточных серверов:
//!     GazProduvka.exe → драйвер PostgreSQL (Rust) → сервер PostgreSQL.
//!
//! Принципы:
//! * пароль вводится один раз, хранится в защищённом хранилище ОС
//!   (Windows Credential Manager) и никогда не возвращается в интерфейс;
//! * сессия переводится в режим только чтения, выполняются только SELECT;
//! * имена схем/таблиц/столбцов проверяются по системным каталогам,
//!   значения передаются только параметрами запроса;
//! * объём выборки ограничен, загрузка постраничная и инкрементальная.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::sync::Mutex;
use tokio_postgres::config::SslMode;
use tokio_postgres::types::ToSql;
use tokio_postgres::Client;

const KEYRING_SERVICE: &str = "GazProduvka PostgreSQL";
const PREVIEW_MAX: u32 = 200;
const FETCH_MAX: u32 = 50_000;

/* ============================== модели ============================== */

fn d_port() -> u16 { 5432 }
fn d_auth() -> String { "password".into() }
fn d_ssl() -> String { "prefer".into() }
fn d_timeout() -> u64 { 15 }
fn d_left() -> String { "left".into() }

/// Профиль подключения (без пароля).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "d_port")]
    pub port: u16,
    pub database: String,
    #[serde(default)]
    pub user: String,
    /// "password" — пароль (SCRAM-SHA-256 / MD5 / открытый, по требованию сервера); "none" — без пароля (trust)
    #[serde(default = "d_auth")]
    pub auth: String,
    /// disable | prefer | require | verify-ca | verify-full
    #[serde(default = "d_ssl")]
    pub ssl: String,
    /// тайм-аут подключения, с
    #[serde(default = "d_timeout")]
    pub timeout: u64,
    #[serde(default)]
    pub app_name: Option<String>,
    /// дополнительные параметры сервера (строка options, например "-c search_path=scada")
    #[serde(default)]
    pub options: Option<String>,
    /// часовой пояс данных
    #[serde(default)]
    pub tz: Option<String>,
    #[serde(default)]
    pub save_password: bool,
    /// вычисляется при чтении: пароль сохранён в хранилище ОС
    #[serde(default)]
    pub has_password: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Col {
    pub name: String,
    #[serde(rename = "type")]
    pub typ: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Rel {
    pub schema: String,
    pub name: String,
    /// table | view | matview | partitioned | foreign
    pub kind: String,
    /// оценка числа строк по статистике (pg_class.reltuples)
    pub rows: i64,
    /// у пользователя есть право SELECT
    pub select: bool,
    pub comment: Option<String>,
    pub columns: Vec<Col>,
}

#[derive(Clone, Debug, Default)]
struct Catalog {
    rels: Vec<Rel>,
}
impl Catalog {
    fn find(&self, schema: &str, name: &str) -> Option<&Rel> {
        self.rels.iter().find(|r| r.schema == schema && r.name == name)
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// столбец: "col" (основная таблица) или "alias.col"
    pub column: String,
    /// = <> > >= < <= contains in null notnull
    pub op: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Join {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    #[serde(rename = "type", default = "d_left")]
    pub kind: String,
    /// пары [левый "alias.col", правый "col" присоединяемой таблицы]
    pub on: Vec<(String, String)>,
}

/// Набор данных для загрузки в ГазПродувку (таблица/VIEW + сопоставление полей).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub database: String,
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub joins: Vec<Join>,
    pub fields: HashMap<String, String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// нижняя граница диапазона дат (ISO), используется при первичной загрузке
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    clients: Mutex<HashMap<String, Arc<Client>>>,
    catalogs: Mutex<HashMap<String, Catalog>>,
    /// пароли, которые пользователь не захотел сохранять, — только на время сеанса
    session_pw: Mutex<HashMap<String, String>>,
}

/* ============================ вспомогательное ============================ */

fn qi(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

enum P {
    S(String),
    A(Vec<String>),
}
fn refs(p: &[P]) -> Vec<&(dyn ToSql + Sync)> {
    p.iter()
        .map(|x| match x {
            P::S(s) => s as &(dyn ToSql + Sync),
            P::A(v) => v as &(dyn ToSql + Sync),
        })
        .collect()
}

fn pg_err(e: tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let code = db.code().code();
        let hint = match code {
            "28P01" => "Неверный пароль или имя пользователя.",
            "28000" => "Сервер запретил подключение для этого пользователя или адреса (pg_hba.conf).",
            "3D000" => "База данных с таким именем не найдена.",
            "42501" => "Недостаточно прав: нужен доступ SELECT.",
            "42P01" => "Таблица или представление не найдены.",
            "57014" => "Превышено время выполнения запроса.",
            "53300" => "На сервере исчерпан лимит подключений.",
            "25006" => "Сессия работает только на чтение — изменения базы запрещены.",
            _ => "",
        };
        return format!("{} [{}] {}", db.message(), code, hint).trim().to_string();
    }
    let s = e.to_string();
    let l = s.to_lowercase();
    if l.contains("timed out") || l.contains("timeout") {
        return format!("Тайм-аут подключения: сервер не ответил. Проверьте адрес, порт, сетевой экран и параметр listen_addresses. ({})", s);
    }
    if l.contains("refused") || l.contains("10061") {
        return format!("Подключение отклонено: по этому адресу и порту PostgreSQL не принимает соединения. ({})", s);
    }
    if l.contains("no such host") || l.contains("failed to lookup") || l.contains("11001") {
        return format!("Сервер не найден: проверьте имя или IP-адрес. ({})", s);
    }
    if l.contains("tls") || l.contains("ssl") || l.contains("certificate") {
        return format!("Ошибка защищённого соединения (TLS/SSL): {}", s);
    }
    if l.contains("password missing") {
        return "Сервер требует пароль, а он не задан.".into();
    }
    s
}

fn kind_name(k: &str) -> &'static str {
    match k {
        "r" => "table",
        "v" => "view",
        "m" => "matview",
        "p" => "partitioned",
        "f" => "foreign",
        _ => "other",
    }
}

fn valid_tz(tz: &str) -> bool {
    !tz.is_empty() && tz.len() < 64 && tz.chars().all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
}

fn valid_type(t: &str) -> bool {
    !t.is_empty() && t.len() < 128 && t.chars().all(|c| c.is_alphanumeric() || " _(),[]\".".contains(c))
}

/* ======================= хранение профилей и паролей ======================= */

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}
fn load_profiles(app: &tauri::AppHandle) -> Vec<Profile> {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<Profile>>(&s).ok())
        .unwrap_or_default()
}
fn save_profiles(app: &tauri::AppHandle, v: &[Profile]) -> Result<(), String> {
    let clean: Vec<Profile> = v.iter().map(|p| Profile { has_password: false, ..p.clone() }).collect();
    let s = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?;
    std::fs::write(store_path(app)?, s).map_err(|e| e.to_string())
}
fn secret_get(id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, id).ok()?.get_password().ok()
}
fn secret_set(id: &str, pw: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .and_then(|e| e.set_password(pw))
        .map_err(|e| format!("Не удалось сохранить пароль в хранилище Windows: {}", e))
}
fn secret_del(id: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, id) {
        let _ = e.delete_credential();
    }
}
fn new_id() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("pg{:x}", n)
}

/* ============================== подключение ============================== */

async fn open(p: &Profile, db: &str, pw: Option<String>) -> Result<(Client, bool), String> {
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&p.host)
        .port(p.port)
        .dbname(db)
        .user(&p.user)
        .connect_timeout(Duration::from_secs(p.timeout.clamp(3, 120)))
        .keepalives(true)
        .keepalives_idle(Duration::from_secs(30))
        .application_name(p.app_name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("GazProduvka"));
    if let Some(o) = p.options.as_deref() {
        if !o.trim().is_empty() {
            cfg.options(o.trim());
        }
    }
    if p.auth != "none" {
        match pw {
            Some(x) if !x.is_empty() => {
                cfg.password(x);
            }
            _ => return Err("Пароль не задан. Введите пароль в окне подключения.".into()),
        }
    }
    let client = if p.ssl == "disable" {
        cfg.ssl_mode(SslMode::Disable);
        let (c, conn) = cfg.connect(tokio_postgres::NoTls).await.map_err(pg_err)?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        c
    } else {
        let mut b = native_tls::TlsConnector::builder();
        match p.ssl.as_str() {
            "verify-full" => {}
            "verify-ca" => {
                b.danger_accept_invalid_hostnames(true);
            }
            _ => {
                // prefer / require: шифрование без проверки сертификата (как в libpq)
                b.danger_accept_invalid_certs(true);
                b.danger_accept_invalid_hostnames(true);
            }
        }
        let tls = postgres_native_tls::MakeTlsConnector::new(b.build().map_err(|e| e.to_string())?);
        cfg.ssl_mode(if p.ssl == "prefer" { SslMode::Prefer } else { SslMode::Require });
        let (c, conn) = cfg.connect(tls).await.map_err(pg_err)?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        c
    };
    let tz = p.tz.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Asia/Tashkent".into());
    if !valid_tz(&tz) {
        return Err(format!("Недопустимое имя часового пояса: {}", tz));
    }
    client
        .batch_execute(&format!(
            "SET default_transaction_read_only = on; SET statement_timeout = '120s'; SET TIME ZONE '{}'",
            tz
        ))
        .await
        .map_err(pg_err)?;
    let tls_used = client
        .query_one("SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)::text", &[])
        .await
        .map(|r| r.get::<_, String>(0) == "true")
        .unwrap_or(false);
    Ok((client, tls_used))
}

async fn password_for(state: &AppState, id: &str) -> Option<String> {
    if let Some(p) = state.session_pw.lock().await.get(id) {
        return Some(p.clone());
    }
    secret_get(id)
}

fn profile_by_id(app: &tauri::AppHandle, id: &str) -> Result<Profile, String> {
    load_profiles(app)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Подключение не найдено".to_string())
}

/// Клиент для (подключение, база): переиспользуется, при обрыве — переподключение.
async fn client_for(app: &tauri::AppHandle, state: &AppState, id: &str, db: Option<&str>) -> Result<Arc<Client>, String> {
    let p = profile_by_id(app, id)?;
    let dbn = db.filter(|d| !d.is_empty()).unwrap_or(&p.database).to_string();
    let key = format!("{}|{}", id, dbn);
    {
        let m = state.clients.lock().await;
        if let Some(c) = m.get(&key) {
            if !c.is_closed() {
                return Ok(c.clone());
            }
        }
    }
    let pw = password_for(state, id).await;
    let (c, _) = open(&p, &dbn, pw).await?;
    let c = Arc::new(c);
    state.clients.lock().await.insert(key, c.clone());
    Ok(c)
}

async fn drop_if_closed(state: &AppState, id: &str, db: &str, c: &Client) {
    if c.is_closed() {
        state.clients.lock().await.remove(&format!("{}|{}", id, db));
    }
}

/* ============================== системные каталоги ============================== */

async fn load_catalog(c: &Client) -> Result<Catalog, String> {
    let rels = c
        .query(
            "SELECT n.nspname::text, c.relname::text, c.relkind::text, GREATEST(c.reltuples, 0)::bigint::text, \
                    has_table_privilege(c.oid, 'SELECT')::text, obj_description(c.oid, 'pg_class') \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r','v','m','p','f') \
               AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' \
               AND has_schema_privilege(n.oid, 'USAGE') \
             ORDER BY 1, 2",
            &[],
        )
        .await
        .map_err(pg_err)?;
    let cols = c
        .query(
            "SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod) \
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r','v','m','p','f') AND a.attnum > 0 AND NOT a.attisdropped \
               AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' \
               AND has_schema_privilege(n.oid, 'USAGE') \
             ORDER BY 1, 2, a.attnum",
            &[],
        )
        .await
        .map_err(pg_err)?;
    let mut out: Vec<Rel> = rels
        .iter()
        .map(|r| Rel {
            schema: r.get(0),
            name: r.get(1),
            kind: kind_name(&r.get::<_, String>(2)).into(),
            rows: r.get::<_, String>(3).parse().unwrap_or(-1),
            select: r.get::<_, String>(4) == "true",
            comment: r.get(5),
            columns: vec![],
        })
        .collect();
    let mut idx: HashMap<(String, String), usize> = HashMap::new();
    for (i, r) in out.iter().enumerate() {
        idx.insert((r.schema.clone(), r.name.clone()), i);
    }
    for r in cols.iter() {
        let k = (r.get::<_, String>(0), r.get::<_, String>(1));
        if let Some(&i) = idx.get(&k) {
            out[i].columns.push(Col { name: r.get(2), typ: r.get(3) });
        }
    }
    Ok(Catalog { rels: out })
}

async fn catalog_for(app: &tauri::AppHandle, state: &AppState, id: &str, db: &str, refresh: bool) -> Result<(Arc<Client>, Catalog), String> {
    let c = client_for(app, state, id, Some(db)).await?;
    let key = format!("{}|{}", id, db);
    if !refresh {
        if let Some(cat) = state.catalogs.lock().await.get(&key) {
            return Ok((c, cat.clone()));
        }
    }
    let cat = match load_catalog(&c).await {
        Ok(x) => x,
        Err(e) => {
            drop_if_closed(state, id, db, &c).await;
            return Err(e);
        }
    };
    state.catalogs.lock().await.insert(key, cat.clone());
    Ok((c, cat))
}

/* ======================= построение безопасных запросов ======================= */

struct Q<'a> {
    alias: Vec<(String, &'a Rel)>,
}
impl<'a> Q<'a> {
    /// "alias.col" или "col" (основная таблица) → (выражение SQL, тип столбца)
    fn col(&self, s: &str) -> Result<(String, String), String> {
        let (a, c) = match s.split_once('.') {
            Some((a, c)) if self.alias.iter().any(|(x, _)| x == a) => (a.to_string(), c.to_string()),
            _ => ("m".to_string(), s.to_string()),
        };
        let rel = self.alias.iter().find(|(x, _)| *x == a).map(|(_, r)| *r).ok_or_else(|| format!("Неизвестный псевдоним таблицы: {}", a))?;
        let col = rel.columns.iter().find(|x| x.name == c).ok_or_else(|| format!("Столбец не найден: {}.{}", rel.name, c))?;
        Ok((format!("{}.{}", a, qi(&col.name)), col.typ.clone()))
    }
}

fn build_from<'a>(cat: &'a Catalog, schema: &str, table: &str, joins: &[Join]) -> Result<(String, Q<'a>), String> {
    let main = cat.find(schema, table).ok_or_else(|| format!("Таблица или представление не найдены: {}.{}", schema, table))?;
    if !main.select {
        return Err(format!("Нет права SELECT на {}.{}", schema, table));
    }
    let mut q = Q { alias: vec![("m".into(), main)] };
    let mut from = format!("{}.{} m", qi(schema), qi(table));
    for (k, j) in joins.iter().enumerate() {
        let js = j.schema.clone().unwrap_or_else(|| schema.to_string());
        let rel = cat.find(&js, &j.table).ok_or_else(|| format!("Связанная таблица не найдена: {}.{}", js, j.table))?;
        let al = format!("j{}", k + 1);
        q.alias.push((al.clone(), rel));
        if j.on.is_empty() {
            return Err(format!("Не задано условие связи для {}", j.table));
        }
        let mut conds = vec![];
        for (l, r) in j.on.iter() {
            let (le, _) = q.col(l)?;
            let rr = if r.contains('.') { r.clone() } else { format!("{}.{}", al, r) };
            let (re, _) = q.col(&rr)?;
            conds.push(format!("{} = {}", le, re));
        }
        let kw = if j.kind == "inner" { "INNER" } else { "LEFT" };
        from.push_str(&format!(" {} JOIN {}.{} {} ON {}", kw, qi(&js), qi(&j.table), al, conds.join(" AND ")));
    }
    Ok((from, q))
}

fn build_filters(q: &Q, filters: &[Filter], params: &mut Vec<P>, wh: &mut Vec<String>) -> Result<(), String> {
    for f in filters {
        let (e, t) = q.col(&f.column)?;
        let v = f.value.clone().unwrap_or_default();
        let mut push = |x: P| {
            params.push(x);
            params.len()
        };
        match f.op.as_str() {
            "null" => wh.push(format!("{} IS NULL", e)),
            "notnull" => wh.push(format!("{} IS NOT NULL", e)),
            "contains" => {
                let n = push(P::S(v));
                wh.push(format!("{}::text ILIKE '%' || ${}::text || '%'", e, n));
            }
            "in" => {
                let list: Vec<String> = v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
                let n = push(P::A(list));
                wh.push(format!("{}::text = ANY(${}::text[])", e, n));
            }
            "=" | "<>" | ">" | ">=" | "<" | "<=" => {
                if !valid_type(&t) {
                    return Err(format!("Неподдерживаемый тип столбца для сравнения: {}", t));
                }
                let n = push(P::S(v));
                wh.push(format!("{} {} CAST(${}::text AS {})", e, f.op, n, t));
            }
            other => return Err(format!("Неизвестная операция фильтра: {}", other)),
        }
    }
    Ok(())
}

const KNOWN: [&str; 16] = [
    "fieldId", "fieldName", "wellId", "wellName", "ts", "date", "time", "pwh", "pline", "recId", "updatedAt", "choke", "rate", "temp", "gamma", "status",
];

/* ============================== команды ============================== */

#[tauri::command]
fn app_info() -> Value {
    json!({ "native": true, "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS })
}

#[tauri::command]
fn conn_list(app: tauri::AppHandle) -> Vec<Profile> {
    load_profiles(&app)
        .into_iter()
        .map(|mut p| {
            p.has_password = p.auth == "none" || secret_get(&p.id).is_some();
            p
        })
        .collect()
}

/// Сохранить профиль. Пароль (если передан) уходит только в хранилище ОС
/// или в память сеанса и никогда не возвращается обратно в интерфейс.
#[tauri::command]
async fn conn_save(app: tauri::AppHandle, state: tauri::State<'_, AppState>, profile: Profile, password: Option<String>) -> Result<Profile, String> {
    let mut p = profile;
    if p.name.trim().is_empty() || p.host.trim().is_empty() || p.database.trim().is_empty() {
        return Err("Заполните имя подключения, сервер и базу данных".into());
    }
    if p.id.is_empty() {
        p.id = new_id();
    }
    let mut all = load_profiles(&app);
    if all.iter().any(|x| x.name == p.name && x.id != p.id) {
        return Err("Подключение с таким именем уже существует".into());
    }
    if let Some(pw) = password.filter(|s| !s.is_empty()) {
        if p.save_password {
            secret_set(&p.id, &pw)?;
            state.session_pw.lock().await.remove(&p.id);
        } else {
            secret_del(&p.id);
            state.session_pw.lock().await.insert(p.id.clone(), pw);
        }
    } else if !p.save_password {
        secret_del(&p.id);
    }
    all.retain(|x| x.id != p.id);
    all.push(p.clone());
    save_profiles(&app, &all)?;
    // параметры могли измениться — закрыть старые соединения
    state.clients.lock().await.retain(|k, _| !k.starts_with(&format!("{}|", p.id)));
    state.catalogs.lock().await.retain(|k, _| !k.starts_with(&format!("{}|", p.id)));
    p.has_password = p.auth == "none" || secret_get(&p.id).is_some() || state.session_pw.lock().await.contains_key(&p.id);
    Ok(p)
}

#[tauri::command]
async fn conn_delete(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut all = load_profiles(&app);
    all.retain(|x| x.id != id);
    save_profiles(&app, &all)?;
    secret_del(&id);
    state.session_pw.lock().await.remove(&id);
    state.clients.lock().await.retain(|k, _| !k.starts_with(&format!("{}|", id)));
    state.catalogs.lock().await.retain(|k, _| !k.starts_with(&format!("{}|", id)));
    Ok(())
}

/// Проверка подключения по введённым параметрам (без сохранения).
#[tauri::command]
async fn pg_test(state: tauri::State<'_, AppState>, profile: Profile, password: Option<String>) -> Result<Value, String> {
    let pw = match password.filter(|s| !s.is_empty()) {
        Some(x) => Some(x),
        None if !profile.id.is_empty() => password_for(&state, &profile.id).await,
        None => None,
    };
    let t0 = Instant::now();
    let (c, tls) = open(&profile, &profile.database, pw).await?;
    let r = c
        .query_one("SELECT version(), current_user::text, current_database()::text, current_setting('default_transaction_read_only')", &[])
        .await
        .map_err(pg_err)?;
    let ms = t0.elapsed().as_millis() as u64;
    Ok(json!({ "version": r.get::<_, String>(0), "user": r.get::<_, String>(1), "database": r.get::<_, String>(2), "readOnly": r.get::<_, String>(3) == "on", "tls": tls, "ms": ms }))
}

/// Установить прямое соединение по сохранённому профилю.
#[tauri::command]
async fn pg_connect(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String, database: Option<String>) -> Result<Value, String> {
    let p = profile_by_id(&app, &id)?;
    let db = database.unwrap_or_else(|| p.database.clone());
    state.clients.lock().await.remove(&format!("{}|{}", id, db));
    let t0 = Instant::now();
    let c = client_for(&app, &state, &id, Some(&db)).await?;
    let r = c.query_one("SELECT version(), current_user::text, current_database()::text", &[]).await.map_err(pg_err)?;
    Ok(json!({ "version": r.get::<_, String>(0), "user": r.get::<_, String>(1), "database": r.get::<_, String>(2), "ms": t0.elapsed().as_millis() as u64 }))
}

#[tauri::command]
async fn pg_disconnect(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.clients.lock().await.retain(|k, _| !k.starts_with(&format!("{}|", id)));
    state.catalogs.lock().await.retain(|k, _| !k.starts_with(&format!("{}|", id)));
    Ok(())
}

/// Базы данных сервера, к которым у пользователя есть право CONNECT.
#[tauri::command]
async fn pg_databases(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String) -> Result<Vec<String>, String> {
    let p = profile_by_id(&app, &id)?;
    let c = client_for(&app, &state, &id, None).await?;
    let r = c
        .query(
            "SELECT datname::text FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY 1",
            &[],
        )
        .await;
    match r {
        Ok(rows) => Ok(rows.iter().map(|x| x.get::<_, String>(0)).collect()),
        Err(e) => {
            drop_if_closed(&state, &id, &p.database, &c).await;
            Err(pg_err(e))
        }
    }
}

/// Navigator: схемы, таблицы, представления, столбцы и типы выбранной базы.
#[tauri::command]
async fn pg_navigator(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String, database: String) -> Result<Value, String> {
    let (_, cat) = catalog_for(&app, &state, &id, &database, true).await?;
    let mut schemas: Vec<String> = cat.rels.iter().map(|r| r.schema.clone()).collect();
    schemas.dedup();
    Ok(json!({ "database": database, "schemas": schemas, "relations": cat.rels }))
}

/// Предварительный просмотр (до 200 строк) с выбором столбцов и фильтрами.
#[tauri::command]
async fn pg_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    database: String,
    schema: String,
    table: String,
    columns: Option<Vec<String>>,
    filters: Option<Vec<Filter>>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let (c, cat) = catalog_for(&app, &state, &id, &database, false).await?;
    let (from, q) = build_from(&cat, &schema, &table, &[])?;
    let rel = q.alias[0].1;
    let cols: Vec<String> = match columns {
        Some(v) if !v.is_empty() => v,
        _ => rel.columns.iter().map(|x| x.name.clone()).collect(),
    };
    let mut sel = vec![];
    let mut types = vec![];
    for name in cols.iter() {
        let (e, t) = q.col(name)?;
        sel.push(format!("{}::text", e));
        types.push(t);
    }
    let mut params = vec![];
    let mut wh = vec![];
    build_filters(&q, &filters.unwrap_or_default(), &mut params, &mut wh)?;
    let lim = limit.unwrap_or(PREVIEW_MAX).clamp(1, PREVIEW_MAX);
    let sql = format!(
        "SELECT {} FROM {}{} LIMIT {}",
        if sel.is_empty() { "NULL".into() } else { sel.join(", ") },
        from,
        if wh.is_empty() { String::new() } else { format!(" WHERE {}", wh.join(" AND ")) },
        lim
    );
    let t0 = Instant::now();
    let rows = match c.query(sql.as_str(), &refs(&params)).await {
        Ok(r) => r,
        Err(e) => {
            drop_if_closed(&state, &id, &database, &c).await;
            return Err(pg_err(e));
        }
    };
    let data: Vec<Vec<Option<String>>> = rows.iter().map(|r| (0..cols.len()).map(|i| r.get::<_, Option<String>>(i)).collect()).collect();
    Ok(json!({ "columns": cols, "types": types, "rows": data, "estimatedRows": rel.rows, "ms": t0.elapsed().as_millis() as u64 }))
}

/// Постраничная инкрементальная загрузка набора данных в формате ядра ГазПродувки.
#[tauri::command]
async fn pg_fetch(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    dataset: Dataset,
    since: Option<String>,
    since_id: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let (c, cat) = catalog_for(&app, &state, &id, &dataset.database, false).await?;
    let (from, q) = build_from(&cat, &dataset.schema, &dataset.table, &dataset.joins)?;
    let f = &dataset.fields;
    for k in f.keys() {
        if !KNOWN.contains(&k.as_str()) {
            return Err(format!("Неизвестное поле сопоставления: {}", k));
        }
    }
    for k in ["wellId", "pwh", "pline"] {
        if f.get(k).map(|s| s.is_empty()).unwrap_or(true) {
            return Err(format!("Не сопоставлено обязательное поле: {}", k));
        }
    }
    let r = |k: &str| -> Result<Option<String>, String> {
        match f.get(k).filter(|s| !s.is_empty()) {
            Some(s) => Ok(Some(q.col(s)?.0)),
            None => Ok(None),
        }
    };
    let ts_expr = if let Some(ts) = r("ts")? {
        ts
    } else if let Some(d) = r("date")? {
        match r("time")? {
            Some(t) => format!("({} + {})", d, t),
            None => format!("{}::timestamp", d),
        }
    } else {
        return Err("Сопоставьте timestamp или дату (и время) измерения".into());
    };
    let cur_expr = r("updatedAt")?.unwrap_or_else(|| ts_expr.clone());
    let id_expr = r("recId")?;
    let mut sel = vec![];
    for (a, k) in [
        ("f", "fieldId"), ("fn", "fieldName"), ("w", "wellId"), ("wn", "wellName"), ("pwh", "pwh"), ("pline", "pline"), ("rid", "recId"), ("upd", "updatedAt"),
        ("choke", "choke"), ("rate", "rate"), ("temp", "temp"), ("gamma", "gamma"), ("st", "status"),
    ] {
        if let Some(e) = r(k)? {
            sel.push(format!("{}::text AS {}", e, a));
        }
    }
    let mut params: Vec<P> = vec![];
    let mut wh: Vec<String> = vec![];
    if let Some(s) = since.filter(|s| !s.is_empty()) {
        params.push(P::S(s));
        let n = params.len();
        match (id_expr.as_ref(), since_id.filter(|s| !s.is_empty())) {
            (Some(ie), Some(sid)) => {
                params.push(P::S(sid));
                let m = params.len();
                wh.push(format!(
                    "({c} > CAST(${n}::text AS timestamp) OR ({c} = CAST(${n}::text AS timestamp) AND {ie}::text > ${m}::text))",
                    c = cur_expr, n = n, ie = ie, m = m
                ));
            }
            _ => wh.push(format!("{} > CAST(${}::text AS timestamp)", cur_expr, n)),
        }
    }
    if let Some(x) = dataset.from.clone().filter(|s| !s.is_empty()) {
        params.push(P::S(x));
        wh.push(format!("{} >= CAST(${}::text AS timestamp)", ts_expr, params.len()));
    }
    if let Some(x) = dataset.to.clone().filter(|s| !s.is_empty()) {
        params.push(P::S(x));
        wh.push(format!("{} <= CAST(${}::text AS timestamp)", ts_expr, params.len()));
    }
    build_filters(&q, &dataset.filters, &mut params, &mut wh)?;
    let lim = limit.unwrap_or(5000).clamp(1, FETCH_MAX);
    let sql = format!(
        "SELECT {sel}, to_char({ts}, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS ts, to_char({cur}, 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS cur{cid} FROM {from}{wh} ORDER BY {cur}{oid} LIMIT {lim}",
        sel = sel.join(", "),
        ts = ts_expr,
        cur = cur_expr,
        cid = id_expr.as_ref().map(|e| format!(", {}::text AS cid", e)).unwrap_or_default(),
        from = from,
        wh = if wh.is_empty() { String::new() } else { format!(" WHERE {}", wh.join(" AND ")) },
        oid = id_expr.as_ref().map(|e| format!(", {}::text", e)).unwrap_or_default(),
        lim = lim + 1
    );
    let rows = match c.query(sql.as_str(), &refs(&params)).await {
        Ok(x) => x,
        Err(e) => {
            drop_if_closed(&state, &id, &dataset.database, &c).await;
            return Err(pg_err(e));
        }
    };
    let more = rows.len() as u32 > lim;
    let mut out: Vec<Value> = Vec::with_capacity(rows.len().min(lim as usize));
    for row in rows.iter().take(lim as usize) {
        let mut m = Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let v: Option<String> = row.get(i);
            m.insert(col.name().to_string(), v.map(Value::String).unwrap_or(Value::Null));
        }
        out.push(Value::Object(m));
    }
    let cursor = out.last().map(|l| json!({ "since": l.get("cur"), "sinceId": l.get("cid") }));
    Ok(json!({ "count": out.len(), "rows": out, "next": if more { cursor.clone().unwrap_or(Value::Null) } else { Value::Null },"cursor": cursor }))
}

/// Список скважин набора данных (проверка сопоставления).
#[tauri::command]
async fn pg_wells(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String, dataset: Dataset) -> Result<Value, String> {
    let (c, cat) = catalog_for(&app, &state, &id, &dataset.database, false).await?;
    let (from, q) = build_from(&cat, &dataset.schema, &dataset.table, &dataset.joins)?;
    let f = &dataset.fields;
    let mut cols = vec![];
    for (a, k) in [("f", "fieldId"), ("fn", "fieldName"), ("w", "wellId"), ("wn", "wellName")] {
        if let Some(s) = f.get(k).filter(|s| !s.is_empty()) {
            cols.push(format!("{}::text AS {}", q.col(s)?.0, a));
        }
    }
    if cols.is_empty() {
        return Err("Сопоставьте хотя бы ID скважины".into());
    }
    let ts = match (f.get("ts").filter(|s| !s.is_empty()), f.get("date").filter(|s| !s.is_empty())) {
        (Some(t), _) => q.col(t)?.0,
        (None, Some(d)) => format!("{}::timestamp", q.col(d)?.0),
        _ => "NULL::timestamp".into(),
    };
    let mut params = vec![];
    let mut wh = vec![];
    build_filters(&q, &dataset.filters, &mut params, &mut wh)?;
    let grp: Vec<String> = (1..=cols.len()).map(|i| i.to_string()).collect();
    let sql = format!(
        "SELECT {}, count(*)::text AS n, to_char(min({ts}), 'YYYY-MM-DD HH24:MI') AS t0, to_char(max({ts}), 'YYYY-MM-DD HH24:MI') AS t1 FROM {}{} GROUP BY {} ORDER BY {} LIMIT 5000",
        cols.join(", "),
        from,
        if wh.is_empty() { String::new() } else { format!(" WHERE {}", wh.join(" AND ")) },
        grp.join(", "),
        grp.join(", "),
        ts = ts
    );
    let rows = c.query(sql.as_str(), &refs(&params)).await.map_err(pg_err)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut m = Map::new();
            for (i, col) in row.columns().iter().enumerate() {
                let v: Option<String> = row.get(i);
                m.insert(col.name().to_string(), v.map(Value::String).unwrap_or(Value::Null));
            }
            Value::Object(m)
        })
        .collect();
    Ok(Value::Array(out))
}

/// Сохранение отчётов и резервных копий в папку «Загрузки».
#[tauri::command]
fn save_file(name: String, b64: String) -> Result<String, String> {
    let data = B64.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
    let dir = dirs::download_dir().or_else(dirs::document_dir).ok_or("Папка «Загрузки» не найдена")?;
    let safe: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let mut path = dir.join(&safe);
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{}", e)),
        None => (safe.clone(), String::new()),
    };
    let mut k = 1;
    while path.exists() {
        path = dir.join(format!("{} ({}){}", stem, k, ext));
        k += 1;
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(format!("/select,{}", path)).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = std::path::Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            conn_list,
            conn_save,
            conn_delete,
            pg_test,
            pg_connect,
            pg_disconnect,
            pg_databases,
            pg_navigator,
            pg_preview,
            pg_fetch,
            pg_wells,
            save_file,
            reveal_file
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка запуска ГазПродувки");
}
