#!/usr/bin/env python3
"""Сборка единого автономного HTML-файла ГазПродувка."""
import os, re
B = os.path.dirname(os.path.abspath(__file__))
src = lambda n: open(os.path.join(B, 'src', n), encoding='utf-8').read()
def lib(path): return open(path, encoding='utf-8').read().replace('</script', '<\\/script')
parts = [
    ('PptxGenJS 4.0.1 + JSZip (MIT)', lib('/opt/npm-tools/node_modules/pptxgenjs/dist/pptxgen.bundle.js')),
    ('docx 9.8.1 (MIT)', lib(os.path.join(B, 'build', 'docx.min.js'))),
]
app = ['xls.js', 'io.js', 'core.js', 'chart.js', 'db.js', 'sources.js', 'icons.js', 'reports.js', 'app.js', 'views2.js', 'views3.js', 'reportsview.js']
html = '''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ГазПродувка — мониторинг и оптимизация продувок газовых скважин</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='9' fill='%2322374D'/%3E%3Crect x='17' y='12' width='6' height='18' fill='%23F2B33D'/%3E%3Crect x='10' y='18' width='20' height='5' fill='%23F2B33D'/%3E%3C/svg%3E">
<style>
''' + src('styles.css') + '''
</style>
</head>
<body>
<noscript>Для работы программы включите JavaScript.</noscript>
'''
for name, code in parts:
    html += '<script>/* ' + name + ' */\n' + code + '\n</script>\n'
# необязательная библиотека SheetJS для старых .xls подгружается по требованию из CDN
html += '<script>\n' + '\n'.join(src(n) for n in app) + '\n</script>\n</body>\n</html>\n'
out = os.path.join(B, 'dist', 'GazProduvka.html')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(html)
# фронтенд настольной программы (Tauri): тот же единый файл
dk = os.path.join(B, 'desktop', 'dist', 'index.html')
os.makedirs(os.path.dirname(dk), exist_ok=True)
open(dk, 'w', encoding='utf-8').write(html)
print(out, round(len(html.encode('utf-8')) / 1024), 'KB')
