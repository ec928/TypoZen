import os

files = ['TypoZen_App.cs', 'README.md', 'TypoZen_Template.html']
for f in files:
    with open(f, 'r', encoding='utf-8') as file:
        content = file.read()
    content = content.replace('Customize Theme', 'Customise Theme')
    with open(f, 'w', encoding='utf-8-sig' if f.endswith('.cs') else 'utf-8') as file:
        file.write(content)
print("Done")
