# Preview Modern UI

Esta carpeta agrupa las pantallas de referencia de la modernización visual.

Entradas principales:

- `../location/` — GPS Pro.
- `../vehicle/` — Expediente 360º.
- `./index.html` — hub visual de la rama.

La Mini App de GPS requiere abrirse desde Telegram para poder usar `initData`, enviar la posición al backend y utilizar los botones nativos.

El expediente de vehículo también requiere Telegram para consultar datos reales porque el backend valida `initData`.

No usar esta rama como producción hasta completar revisión móvil real y merge explícito.