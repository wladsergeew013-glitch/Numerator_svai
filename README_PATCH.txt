Patch v33: ribbon + group manager cleanup

Replace files in project root with the same relative paths.

What changed:
- ribbon command layout: icon tile + caption below, caption is no longer inside the button border;
- Assign command on ribbon now toggles auto-assign when no selection exists, or assigns current selection once;
- auto-assign no longer depends on whether Group Manager is open;
- removed the old “Назначать выделение сразу” checkbox from Group Manager;
- Group Manager is split into Pipeline / Actions / Groups sections and uses width with multi-column cards/settings;
- backend local project save again excludes gridSettings/viewSettings and writes via .tmp replace.

After replacement run:
frontend: npm run build
backend: python -m py_compile backend/app/main.py
