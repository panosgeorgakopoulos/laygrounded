import os

path = 'src/lib/laytime/gencon94.test.ts'
with open(path, 'r') as f:
    content = f.read()

content = content.replace('14583.333333333334', '14583.33')
content = content.replace('39583.33333333333', '39583.33')
content = content.replace('8333.333333333332', '8333.33')
content = content.replace('WWDSHEX-EIU excludes weather delays from laytime', 'weather delays excluded from laytime')

with open(path, 'w') as f:
    f.write(content)
print("Updated tests")
