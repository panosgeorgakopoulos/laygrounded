import os
import glob
import re

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Skip files that genuinely need service role
    if 'init-demo' in filepath:
        return

    original = content
    # Replace import
    content = content.replace('import { createServiceRoleClient } from "@/lib/supabase/server";', 'import { createClient } from "@/lib/supabase/server";')
    # If the import was slightly different
    content = content.replace('import { createServiceRoleClient } from "../../../lib/supabase/server";', 'import { createClient } from "../../../lib/supabase/server";')

    # Replace initialization
    content = content.replace('const supabase = createServiceRoleClient();', 'const supabase = await createClient();')
    
    if content != original:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Updated {filepath}")

for root, _, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts') or file.endswith('.tsx'):
            process_file(os.path.join(root, file))
