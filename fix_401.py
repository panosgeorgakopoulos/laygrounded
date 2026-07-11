import os

target = 'return NextResponse.json({ error: (e as Error).message }, { status: 401 });'
replacement = '''const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });'''

for root, _, files in os.walk('src/app/api'):
    for file in files:
        if file.endswith('.ts'):
            path = os.path.join(root, file)
            with open(path, 'r') as f:
                content = f.read()
            if target in content:
                content = content.replace(target, replacement)
                with open(path, 'w') as f:
                    f.write(content)
                print(f"Updated {path}")
