# Plan de implementación para Codex

Este documento traduce el producto en tareas implementables y verificables.

## Principio general

Codex debe trabajar por fases pequeñas, con pruebas, migraciones y commits claros. No debe intentar reescribir todo el sistema de una vez.

---

## Fase 0 — Versionar el estado real

### Objetivo

Eliminar la divergencia entre Supabase desplegado y GitHub.

### Tareas

- Obtener la Edge Function `telegram-bot` actualmente desplegada.
- Guardarla en `supabase/functions/telegram-bot/index.ts`.
- Añadir configuración mínima de Supabase Functions necesaria.
- Traer/representar las migraciones existentes en `supabase/migrations/` cuando sea posible sin falsificar historial.
- Documentar qué migraciones fueron creadas fuera del repo.
- Añadir `.env.example` solo con nombres de variables, nunca valores.

### Criterios de aceptación

- El repo contiene el código que corresponde al backend desplegado.
- `TELEGRAM_BOT_TOKEN` no aparece en git.
- Existe una instrucción reproducible de deploy.

---

## Fase 1 — Suite automática de acceso Telegram

### Objetivo

No depender de usuarios reales para validar permisos.

### Implementar

Crear fixtures/helpers para construir payloads Telegram:

- `message /start`
- comando admin
- `callback_query approve:<id>`
- `callback_query reject:<id>`
- update repetido con mismo `update_id`.

Separar en funciones testeables:

- parseo de comandos;
- autorización;
- transición de solicitud;
- normalización de datos Telegram;
- construcción de respuesta/botones.

### Casos mínimos

- unknown -> pending;
- pending -> approved;
- pending -> rejected;
- rejected + `/start` -> sigue rejected;
- approved/active -> acceso;
- inactive -> denegado;
- operario intenta callback admin -> denegado;
- admin aprueba dos veces -> idempotente;
- admin rechaza dos veces -> idempotente;
- callback sobre solicitud resuelta -> no modifica estado indebidamente.

### Criterio de aceptación

Suite ejecutable por Codex/CI sin cuentas Telegram adicionales.

---

## Fase 2 — Consolidación de identidad

### Objetivo

Unificar `telegram_users`, `workers` y evaluar `app_users`.

### Estrategia

No borrar primero.

1. Inspeccionar datos y FK reales.
2. Definir `workers` como modelo objetivo si no aparece una razón técnica fuerte en contra.
3. Añadir campos faltantes (`telegram_username`, first/last name o equivalente) mediante migración.
4. Migrar cuentas existentes conservando roles/estado.
5. Cambiar bot a lectura de `workers` con compatibilidad transitoria.
6. Cambiar aprobaciones/bloqueos a `workers`.
7. Verificar.
8. Solo después preparar limpieza de tablas redundantes.

### Criterios

- un Telegram ID no puede representar dos trabajadores;
- rol admin se conserva;
- bloqueo conserva efecto inmediato;
- parking_events puede apuntar al worker canónico;
- ninguna cuenta se pierde durante migración.

---

## Fase 3 — Estado conversacional persistente

### Objetivo

Permitir flujos multi-mensaje de forma robusta en Edge Functions stateless.

### Tabla sugerida

`bot_sessions` o `operation_drafts`.

Debe incluir:

- actor;
- flow;
- state;
- payload;
- expiración;
- timestamps.

### Reglas

- una sesión activa por usuario/flow salvo justificación;
- `/cancelar` limpia el borrador;
- sesión expirada se recupera con mensaje claro;
- nunca confiar en memoria global de la Edge Function.

---

## Fase 4 — `/dejar` vehículo

### UX objetivo

1. Operario pulsa/escribe `Dejar coche`.
2. Bot solicita matrícula.
3. Normaliza y busca coincidencias.
4. Si ya existe `parked`, pide confirmación antes de reemplazar ubicación.
5. Solicita fotos (definir mínimo configurable; MVP puede aceptar 1+).
6. Solicita ubicación.
7. Evalúa precisión.
8. Buena precisión -> guarda GPS.
9. Mala precisión -> botones con sectores activos + opción `Describir ubicación`.
10. Guarda `vehicles` + `parking_events` + fotos.
11. Devuelve resumen.

### Requisitos de datos

`vehicles`:

- estado actual.

`parking_events`:

- evento `park` histórico.

`vehicle_photos`:

- fotos vinculadas a vehicle/event.

### Criterios

- operación transaccional cuando sea posible;
- no crear evento si faltan datos mínimos y el usuario cancela;
- retry Telegram no duplica operación;
- mala precisión no bloquea el aparcado.

---

## Fase 5 — `/buscar` y `/retirar`

### Buscar

Permitir búsqueda por matrícula completa y, si es seguro/usualmente útil, parcial con límite de resultados.

Mostrar:

- matrícula;
- estado;
- sector;
- descripción;
- GPS;
- precisión;
- hora de aparcado;
- fotos.

### Retirar

1. identificar vehículo;
2. mostrar ubicación;
3. confirmar retirada;
4. crear `parking_events.operation='retrieve'`;
5. actualizar `vehicles.status` y `retrieved_at`.

### Criterios

- no retirar dos veces sin feedback explícito;
- historial intacto;
- fotos siguen consultables.

---

## Fase 6 — Configuración del parking

### Requisito de entrada

Solo admin y confirmación textual exacta:

`Configurar`

### Funciones

- configurar nombre/centro;
- crear sectores;
- editar sector;
- desactivar sector;
- listar sectores;
- configurar umbral GPS.

### Auditoría

Registrar:

- actor;
- before/after cuando proceda;
- timestamp;
- acción.

### Regla

No borrar sectores referenciados históricamente; desactivarlos.

---

## Fase 7 — Fotos completas

### Entrada

Aceptar fotos Telegram y asociarlas a una operación en curso.

### Almacenamiento

- descargar archivo desde Telegram en backend;
- subir a bucket privado;
- registrar metadatos;
- evitar paths con PII.

### Consulta

Desde ficha de vehículo:

- enviar fotos directamente por Telegram cuando sea conveniente;
- o generar signed URLs de corta duración.

### Criterios

- sin bucket público;
- archivo huérfano debe limpiarse o registrarse para cleanup;
- metadata coherente.

---

## Fase 8 — Auditoría y seguridad

### Eventos obligatorios

- access_requested;
- access_approved;
- access_rejected;
- worker_disabled;
- worker_reactivated;
- config_mode_entered;
- sector_created/updated/disabled;
- vehicle_parked;
- vehicle_location_corrected;
- vehicle_retrieved;
- photo_added.

### Revisiones

- Supabase advisors;
- RLS;
- secrets;
- permisos de Storage;
- endpoints webhook;
- logs sin secretos.

---

## Fase 9 — Calidad de UX Telegram

Cuando la lógica esté estable:

- botones persistentes/inline para acciones comunes;
- evitar que el operario memorice comandos;
- `/start` debe mostrar menú según rol;
- `/cancelar` disponible en flujos;
- confirmaciones claras;
- mensajes cortos y accionables;
- paginar listados grandes.

Menú operario sugerido:

```text
🚗 Dejar coche
🔎 Buscar coche
🚙 Retirar coche
❌ Cancelar operación
```

Menú admin añade:

```text
👥 Operarios
📥 Solicitudes
🗺 Configurar parking
📊 Estado
```

---

## Fase 10 — CI y entrega

Añadir workflow que, sin secretos de producción:

- formatee/lint TypeScript;
- ejecute unit tests;
- ejecute tests de integración que puedan usar entorno local/dev;
- falle si detecta secretos conocidos/patrones obvios;
- opcionalmente valide migraciones.

No desplegar automáticamente a producción hasta que el flujo de CI sea estable y exista separación clara de entornos.

---

# Backlog posterior al MVP

No bloquear el MVP por estas ideas:

- mini mapa visual más sofisticado;
- dashboard web del dueño;
- analítica avanzada de ocupación;
- OCR de matrículas;
- reconocimiento de daños/fotos;
- integración profunda con Google Workspace;
- multi-parking;
- optimización de asignación de sectores.

---

# Orden recomendado para Codex

```text
0 Versionar backend
1 Tests de acceso
2 Consolidar identidad
3 Estado conversacional
4 Dejar coche
5 Buscar/retirar
6 Configuración
7 Fotos
8 Auditoría/seguridad
9 UX
10 CI
```

Codex debe detenerse y reportar si descubre una contradicción entre el esquema real y esta documentación, en lugar de inventar una solución silenciosa.
