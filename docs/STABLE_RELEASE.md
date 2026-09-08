# ParkingMartin-G — Release estable

## Baseline actual

- **Producto:** ParkingMartin-G
- **Versión:** 1.4.0
- **Build estable:** 2026.09.09.04
- **Fecha de consolidación:** 2026-09-06
- **Rama de producción:** `main`

Esta release se considera la **línea base estable de producción** de la Mini App hasta que se publique explícitamente un build posterior.

## Alcance protegido de esta release

### Pantalla principal

La home está organizada en tres grupos:

**Operación**
- Centro de Operaciones
- Asignación de tareas
- Vehículos
- Equipo en vivo
- Actividad reciente

**Gestión**
- Gestión de reservas
- Equipo & Accesos
- Expediente 360º

**Sistema**
- Configuración de optimización
- Información del sistema
- GPS Pro · Diagnóstico

Etiquetas funcionales vigentes:

- Centro de Operaciones → `OPERACIÓN`
- Asignación de tareas → `PLANIFICACIÓN · ADMIN`
- Vehículos → `FLOTA`
- Equipo en vivo → `SEGUIMIENTO`
- Actividad reciente → `TRAZABILIDAD`
- Gestión de reservas → `RESERVAS · ADMIN`
- Equipo & Accesos → `ACCESOS · ADMIN`
- Expediente 360º → `EXPEDIENTES`
- Configuración de optimización → `OPTIMIZACIÓN · ADMIN`
- Información del sistema → `SOPORTE · ADMIN`
- GPS Pro · Diagnóstico → `DIAGNÓSTICO`

Las tarjetas marcadas `ADMIN` son visibles únicamente para Root/Admin y sus backends deben volver a comprobar autorización; ocultar la tarjeta nunca sustituye la autorización servidor.

### Asignación manual

- Root/Owner no puede aparecer como trabajador asignable.
- Admin y Operarios activos sí pueden ser responsables.
- La última asignación manual confirmada es la válida.
- Las tareas manuales son constraints duras del optimizador.

### Asistente IA / Optimizer V2

- selección explícita de participantes;
- Root/Owner excluido del reparto;
- un participante seleccionado puede recibir nuevas tareas;
- un trabajador excluido conserva sus tareas manuales pero no recibe nuevas tareas;
- Fast/Optimal pertenecen a Fase 1 estable;
- línea temporal continua 24/7;
- validación física con 0 errores obligatoria;
- acompañamientos y coche de empresa forman parte de la logística física;
- la planificación visual muestra misiones de coche cuando existan;
- Realtime es señal; `optimization_jobs` es fuente de verdad;
- no existe polling periódico;
- Fase 2 de reoptimización permanece experimental y separada.

### Versionado y soporte

La Mini App muestra:

`v1.4.0 · Build 2026.09.09.04`

Root/Admin dispone de **Información del sistema**, que identifica:

- versión/build de Mini App;
- versión/build de backend;
- versión/build del último worker que ejecutó una optimización;
- último job asociado.

El worker estable sella:

- `optimizer_version = 2.1.2`
- `optimizer_build = 2026.09.04.04`


## Contrato y verificación de release

Desde la build **2026.09.06.01**, la fuente canónica de versión es:

`release/manifest.json`

Ese manifiesto declara producto, estado de release, versión/build de Mini App, identificador del Service Worker, versión/build de backend, versión/build independiente del optimizer y las Edge Functions críticas.

El pipeline distingue ahora dos niveles:

1. **Stable Release Guard / Release contract**
   - valida el manifiesto;
   - comprueba que `release.js`, esta documentación, backend, Telegram, Service Worker e identificadores de caché son coherentes con él;
   - comprueba que las Edge Functions críticas declaradas existen en el repositorio;
   - mantiene las protecciones de regresión del flujo event-driven.

2. **Deployed Release Verification**
   - se ejecuta a partir de eventos reales de despliegue de GitHub Pages;
   - ignora despliegues históricos sustituidos por un commit posterior;
   - para el HEAD actual comprueba contra la URL pública que la versión/build y Service Worker servidos corresponden al manifiesto.

Por tanto:

- un **fallo de contrato** significa incoherencia en la release declarada;
- un **fallo de Pages** significa que GitHub no pudo publicar el commit;
- un **fallo de verificación desplegada** significa que Pages terminó pero el contenido servido no corresponde a la release esperada;
- un run antiguo cancelado o sustituido no se interpreta como fallo de la producción actual.

### Verificación externa pendiente de automatización completa

Supabase y Telegram siguen siendo componentes externos al despliegue de Pages.

Para esta baseline se ha comprobado directamente que las siguientes Edge Functions desplegadas en Supabase son idénticas a `main`:

- `reservation-optimization-jobs-v1`
- `telegram-gateway`
- `telegram-modern-action`
- `modern-parking-api`
- `modern-relocate-api`

La URL declarada por `telegram-gateway` y `telegram-modern-action` corresponde a `20260909B04`.

La siguiente evolución del pipeline será convertir estas comprobaciones externas en una verificación automática mediante credenciales de despliegue/gestión, sin exponer secretos en el repositorio. Hasta entonces, un Release contract verde certifica coherencia del código y un Deployed Release Verification verde certifica Pages, pero no debe interpretarse por sí solo como prueba automática del estado remoto de Supabase/Telegram.


## Regla de protección

No modificar silenciosamente esta baseline.

Cualquier cambio posterior que afecte interfaz, permisos, flujo operativo, contrato backend o comportamiento del optimizador debe:

1. actualizar código y pruebas;
2. incrementar `build` en `docs/preview-modern/release.js`;
3. actualizar la versión del backend/worker cuando corresponda;
4. invalidar la caché del Service Worker cuando afecte la Mini App;
5. pasar los tests/smoke aplicables;
6. actualizar este documento si cambia el comportamiento estable;
7. mantener Fase 2 fuera del camino estable salvo promoción explícita.

Un cambio experimental no redefine esta release hasta que se promueva deliberadamente a estable.

## Seguridad aplicada a esta baseline

- **plate_verifications RLS:** resuelto el 2026-09-04.
- RLS habilitado.
- Acceso directo de `anon` y `authenticated` revocado.
- Acceso de producción únicamente desde backend/service-role.
- Debe mantenerse smoke test de OCR en Recogida, Aparcar y Entrega, además de Expediente 360º e informe de vehículo.

### Validación funcional 2026-09-04

Smoke test de producción completado tras endurecer `plate_verifications`:

- Recogida: OK
- Aparcar: OK
- Buscar: OK
- Entrega: OK
- Expediente 360º: OK

El Security Advisor ya no reporta `rls_disabled_in_public` para `plate_verifications`. El aviso restante `rls_enabled_no_policy` es informativo y coherente con el diseño backend-only: no existen políticas cliente y `anon/authenticated` no tienen privilegios directos sobre la tabla.

### Vista de solicitudes rechazadas

Resuelto el 2026-09-04: `telegram_access_requests_visible_rejected` pasó a `security_invoker=true` y se revocó el acceso directo de `anon/authenticated`. El acceso queda backend-only mediante `service_role`. El Security Advisor ya no reporta `security_definer_view` para esta vista.

### RPC de expiración de solicitudes

Resuelto el 2026-09-04: `expire_pending_access_requests()` conserva su ejecución interna mediante `pg_cron` cada 15 minutos, pero se revocó `EXECUTE` a `PUBLIC`, `anon` y `authenticated`. El Security Advisor ya no la reporta como función `SECURITY DEFINER` ejecutable por clientes.

### RPC privilegiados de reservas y ciclo de vida

Resuelto el 2026-09-04: `parking_booking_operational_snapshot(bigint)`, `vehicle_lifecycle_search(bigint,text)` y `vehicle_lifecycle_snapshot(bigint)` mantienen `SECURITY DEFINER` para su uso interno, pero `PUBLIC`, `anon` y `authenticated` ya no tienen `EXECUTE`. El acceso queda únicamente a `service_role`/backend. El Security Advisor ya no reporta estos RPC como ejecutables por clientes.

### search_path de triggers

Resuelto el 2026-09-04: las 8 funciones trigger señaladas por el Security Advisor tienen ahora `search_path=''`. Todos los triggers siguen activos y el advisor ya no reporta `function_search_path_mutable`.

## Validación funcional de la build 2026.09.04.04

Promovida tras smoke test completo de producción:

- Gestión de reservas y transferencia de permisos: OK.
- Asistente IA / Optimizer V2 con worker 2.1.2: OK.
- Aparcar con GPS válido, baja precisión y fallback manual: OK.
- Reubicar con GPS válido, baja precisión y fallback manual: OK.
- Buscar coche y Entrega con navegación solo si existen coordenadas reales: OK.
- Expediente 360º con ubicación GPS y ubicación manual: OK.
- Equipo & Accesos: OK.
- Actividad reciente / trazabilidad: OK.
- Información del sistema: OK.

Cambios incorporados respecto a la baseline anterior:

- preflight automático de rutas al optimizar;
- fallback dinámico/caché de trayectos;
- retirada del botón manual de actualización de trayectos;
- timeout global de optimización de 5 minutos;
- bloqueo de participantes/horizonte durante job activo;
- flujo de autorización visible y dirigido por eventos, sin polling;
- fallback manual cuando GPS está desactivado/no disponible;
- correcciones de navegación Buscar/Entrega y Expediente 360º;
- limpieza inicial de frontend, Service Worker y documentación histórica;
- endpoint de benchmark deshabilitado en producción.

<!-- PMG-POST-BASELINE-2026-09-06:START -->
## Baseline consolidada 2026.09.09.04

Las correcciones posteriores a la baseline del 4 de septiembre quedan consolidadas formalmente en **1.4.0 / Build 2026.09.09.04**.

Incluye:

- navegación visual modernizada en pantallas normales;
- reanudación y revalidación de flujos protegidos tras recarga/reapertura;
- ciclo de aviso y expiración de sesión protegida con entrada segura a una nueva sesión;
- sesión de acceso backend opaca y revocable, con reutilización segura dentro del mismo WebView;
- vinculación de la sesión cacheada a `auth_date` y al `Telegram user.id` actual antes de reutilizar el token, sin relectura directa de tokens cacheados que no hayan superado esa validación;
- mensaje Telegram específico de nueva sesión tras expiración reciente;
- corrección de los conteos del informe automático de rendimiento;
- home compacta por defecto en matriz de 2 columnas, con alternancia a lista compacta de 1 columna y preferencia persistente;
- corrección del falso estado offline durante arranque desde Telegram;
- doble comprobación de reachability estática antes de declarar falta de Internet;
- `connectivity-ping.txt` forzado a red para impedir falsos positivos por caché;
- corrección F-03: el control flotante para volver arriba se oculta mientras el panel de asignación está abierto y recupera su comportamiento normal al cerrarlo;
- corrección del acceso al Asistente IA: las acciones de usuario vuelven a usar el planner autenticado, mientras `reservation-ai-planner-v2` permanece restringido a llamadas server-to-server;\n- las APIs operativas Recogida, Aparcar, Reubicar, Buscar y Entrega aceptan la access session backend revocable antes de recurrir a initData fresco;\n- Centro de Operaciones y los flujos Recogida, Aparcar, Reubicar, Buscar y Entrega cargan explícitamente `session-runtime.js?v=7`, sin depender del Service Worker para inyectar la access session;\n- al abrir un flujo nuevo, un estado local antiguo ya expirado se descarta en vez de bloquear la nueva sesión como si acabara de caducar;\n- la Home evita el reflow visible de la cuadrícula mientras se resuelven permisos, mostrando directamente la disposición final;\n- la expiración rutinaria de la access session deja de generar mensajes Telegram repetitivos; las notificaciones de expiración de operaciones se conservan;\n- Buscar coche adopta el mismo patrón moderno de navegación superior que Aparcar, Recogida, Reubicar y Entrega;\n- confirmación del Asistente IA genera el mismo contrato operativo de notificaciones que la asignación manual: detalle de tareas por operario y aviso de reasignación cuando proceda;\n- la asignación manual permite elegir `SIN ASIGNAR` para retirar responsable de tareas seleccionadas, con control de versión, historial y aviso al operario anterior;\n- informe diario de salud de base de datos para Root/Admin a medianoche de Madrid, con tamaño usado/restante, conexiones, consultas largas de cliente, tuplas muertas, notificaciones pendientes y carga operativa;\n- las sesiones persistentes de replicación Realtime/walsender quedan excluidas del indicador de consultas largas para evitar falsos avisos;\n- Service Worker actual: `pmg-shell-v96`;
- runtime de navegación actual: `navigation-runtime.js?v=5`;
- runtime de sesión actual: `session-runtime.js?v=7`;\n- runtime de notificaciones actual: `notification-runtime.js?v=8`;
- runtime de conectividad actual: `offline-runtime.js?v=6`.

Estas correcciones no autorizan a relajar las reglas de permisos, integridad de flujo, OCR, trazabilidad ni seguridad ya definidas para la baseline.
<!-- PMG-POST-BASELINE-2026-09-06:END -->


## Telegram native Android Back contract

La navegación Atrás dentro de la Mini App usa `Telegram.WebApp.BackButton` como mecanismo principal cuando la app se ejecuta dentro de Telegram. Esto permite que el botón/gesto físico Atrás de Android se enrute mediante el evento nativo de Telegram y evita las inconsistencias observadas cuando `pushState/popstate` gobernaba la navegación interna.

Reglas protegidas:

- Home oculta el BackButton nativo.
- Pantallas internas muestran y enlazan el BackButton nativo a `runBack`.
- `pushState/popstate` solo puede actuar como fallback fuera de Telegram.
- No sustituir este comportamiento por History API como mecanismo principal dentro de Telegram.
- Stable Release Guard debe fallar si desaparecen los enlaces nativos o si `popstate` vuelve a gobernar la navegación dentro de Telegram.


## Recuperación explícita de operaciones pendientes

Cuando Recogida, Aparcamiento, Reubicación o Entrega encuentra una flow session todavía activa y recuperable, la Mini App no continúa automáticamente. Debe mostrar de forma bloqueante el tipo de operación y la matrícula y exigir una elección explícita entre continuar la operación pendiente o iniciar otra. Si el usuario elige iniciar otra, la sesión pendiente debe cancelarse primero en backend y solo después limpiarse el estado local.


## Home operativo estable y render inmediato

El Home debe pintar desde el primer render todas las tarjetas comunes del operario sin esperar a la respuesta `dashboard`. Las tarjetas administrativas permanecen ocultas hasta validar el rol y se sitúan al final de su sección para que su aparición no desplace ni reordene las tarjetas comunes ya visibles. La validación de acceso y rol sigue ejecutándose y las APIs continúan aplicando autorización backend.


## Observabilidad de recursos · Root

ParkingMartin-G dispone de una pantalla `Recursos & presupuestos` visible únicamente al rol `owner`/Root. La primera fase mide de forma exacta el tamaño PostgreSQL y los bytes/objetos de Supabase Storage del propio proyecto. El Owner puede definir presupuestos internos y umbrales WARNING/CRITICAL. Estos presupuestos son solo de observabilidad: no modifican límites del proveedor y no bloquean operaciones. Egress, API Requests y Edge Function Invocations no se estiman ni se muestran como métricas exactas hasta disponer de una integración oficial verificada.
