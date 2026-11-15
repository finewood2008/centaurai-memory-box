// Old bookmarks must enter the real application, never the retired demo.
location.replace(new URL('index.html',location.href).href);
