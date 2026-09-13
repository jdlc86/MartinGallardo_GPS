# ParkingMartin-G — Plan de pruebas vigente

## Fuente de verdad

Este plan valida el comportamiento implementado en `main`. Si este documento contradice código, migraciones o `release/manifest.json`, prevalece la implementación y la documentación debe corregirse.

## 1. Entrada, roles y autorización

- `/start` abre la Mini App y no reintroduce menús operativos antiguos en Telegram.
- `telegram-gateway` es el webhook operativo.
- `group` y `supergroup` no ejecutan operaciones privadas ni crean sesiones.
- Operario no accede a funciones ADMIN.
- Admin no puede modificar Root ni sus propios privilegios protegidos.
- `owner` se muestra como **Root** y permanece protegido en backend.
- Toda acción privilegiada se revalida en servidor aunque la UI oculte controles.

## 2. Sesiones

Modelo vigente:

- Telegram `initData` solo sirve para bootstrap y se acepta como máximo durante **10 minutos** (`INIT_DATA_MAX_AGE_SECONDS=600`).
- La sesión de acceso backend dura **22 horas** y es opaca/revocable.
- Las sesiones de flujo protegido de Recogida, Aparcar, Reubicar y Entrega duran **20 minutos**.
- Buscar coche es una consulta autenticada y no crea una sesión de flujo protegida equivalente.

Pruebas:

- firma `initData` inválida -> rechazada;
- `initData` >10 min al intentar crear una nueva access session -> rechazado con UX amigable;
- access session válida -> las APIs compatibles funcionan sin exigir `initData` fresco en cada acción;
- access session caducada/revocada -> acción rechazada y UX de nueva sesión;
- cambio de usuario Telegram no reutiliza una sesión cacheada de otro usuario;
- usuario desactivado o degradado -> la siguiente acción protegida vuelve a comprobar autorización;
- flujo protegido activo puede recuperarse dentro de su vigencia;
- flujo >20 min -> no puede finalizar como sesión válida;
- nunca mostrar códigos internos como `expired_init_data`, `invalid_init_data` o `not_admin` como explicación principal.

## 3. Política UX de errores y conectividad

Probar sin Internet, backend temporalmente no disponible, timeout/5xx, respuesta inválida, sesión caducada, permisos insuficientes, matrícula inválida, foto inválida y GPS insuficiente.

Resultado esperado: mensaje comprensible, accionable y compatible con Día/Noche/Automático. No mostrar stack traces, SQL/PostgREST crudo ni códigos internos. Los avisos no deben duplicarse ni solaparse con controles principales.

## 4. Recogida

- matrícula válida;
- recuperación/cancelación segura de una operación pendiente;
- requisitos dinámicos de evidencia;
- 8 fotos exteriores + 2 interiores obligatorias según la configuración vigente;
- cámara embebida funcional en vertical y horizontal;
- Capturar solo después de recibir un fotograma real;
- fallback seguro si falla la configuración preferida de cámara;
- flash/torch visible cuando el dispositivo lo soporta y fallback visual coherente cuando no;
- cerrar/cancelar detiene las pistas de vídeo;
- galería separada de la cámara;
- guía de fotos visible y compatible con tema/orientación;
- documentación imagen/PDF;
- foto matrícula + OCR;
- mismatch/failed/repetir/override auditado;
- no finalizar si falta evidencia;
- finalizar -> `in_transit` + un solo `pickup`.

## 5. Aparcar

- vehículo nuevo/existente válido;
- `normalized_plate` no se escribe manualmente;
- OCR coincide/mismatch/failed + override auditado;
- GPS válido guarda coordenadas/precisión;
- precisión insuficiente exige descripción manual;
- si GPS no está disponible existe fallback manual;
- confirmar -> `parked` + `park`;
- reintento no duplica efectos.

## 6. Reubicar

- parte de vehículo existente y contexto válido;
- mantiene protección de sesión y control de cambios concurrentes;
- GPS válido actualiza ubicación;
- GPS no disponible permite descripción manual según el flujo vigente;
- finalización idempotente y sin borrar historial previo.

## 7. Buscar coche

- consulta autenticada;
- solo un vehículo `parked` es navegable;
- navegación únicamente con coordenadas reales;
- si no existen coordenadas muestra la descripción manual registrada;
- registra `lookup` sin cambiar el estado del vehículo;
- matrícula inexistente -> mensaje amigable.

## 8. Entrega

- parte de vehículo `parked`;
- recuperación/cancelación segura de operación pendiente;
- navegación solo cuando existen coordenadas reales;
- cámara embebida funcional en vertical/horizontal y torch cuando esté soportado;
- OCR `parking_exit` con mismatch/failed/override;
- no cambia estado antes de confirmar;
- finalizar -> `retrieved` + `retrieve`.

## 9. Expediente 360º

- vehículo sin evidencias y con múltiples etapas;
- miniaturas/ampliación;
- OCR/overrides e historial en español;
- ubicación GPS o descripción manual;
- compartir temporal con URLs firmadas;
- PDF selectivo mantiene siempre el resumen esencial;
- selección de disputa/retención, ubicación, evidencias, OCR e historial;
- selección individual de fotografías;
- límites vigentes de generación: 15 MB / 60 fotos;
- selección temporal de servidor caduca según implementación vigente.

## 10. Equipo en vivo

- una fila vigente por usuario en `worker_live_locations`;
- Telegram Live Location actualiza posición;
- dejar de compartir hace desaparecer al trabajador;
- `live_until` impide marcadores caducados;
- no existe trayectoria histórica;
- `worker_daily_presence` conserva únicamente presencia diaria para informes;
- visible para usuarios activos autorizados.

## 11. Reservas y asignación

- Operario no accede a Gestión de reservas;
- Root/Admin con permisos adecuados puede consultar/mutar según el contrato backend;
- CRUD, búsqueda, control de versión e idempotencia;
- importación Excel informa el resultado y vuelve a mostrar correctamente las reservas importadas;
- asignación manual notifica al operario;
- `SIN ASIGNAR` retira responsable con historial y aviso al anterior cuando corresponda;
- confirmación del Asistente IA aplica el plan y genera el contrato de notificaciones de asignación/reasignación;
- las asignaciones manuales fijadas se respetan como restricciones del optimizador.

## 12. Optimizer V2

- worker `2.1.2 / 2026.09.04.04` según manifest vigente;
- Fast y Optimal pertenecen a Fase 1 estable;
- rolling horizon continuo 24/7;
- participantes/horizonte no cambian durante un job activo;
- `optimization_jobs` es la fuente durable y Realtime solo señaliza cambios;
- ningún resultado con errores de validación física se acepta;
- timeout global según implementación vigente;
- Fase 2 permanece experimental y fuera del camino estable.

## 13. Retención y Factory Reset

Durante el entorno actual de pruebas:

- la retención efectiva de evidencias entregadas está reducida a **5 minutos** para validar mantenimiento;
- sin disputa abierta, el vehículo/evidencia elegible entra en candidatos y el mantenimiento puede purgarlo;
- una disputa abierta impide la purga;
- antes de incorporar usuarios reales debe restaurarse la política efectiva a **15 días**.

Factory Reset:

- solo Root;
- elimina datos operativos definidos por el contrato actual;
- conserva identidad Root y configuración técnica necesaria;
- restaura el estado de escritura de reservas para Owner;
- una ejecución repetida debe ser segura/idempotente.

## 14. Observabilidad y mantenimiento

- informe diario de salud para Root/Admin a medianoche de Madrid;
- métricas de PostgreSQL/Storage coherentes;
- API Requests y Edge Function Invocations se obtienen mediante backend/Management API cuando están disponibles;
- Egress permanece fuera del alcance actual;
- conexiones persistentes Realtime no generan falsos avisos de consultas largas;
- tareas de mantenimiento registran ejecución y errores sin borrar historial de negocio válido.

## 15. Seguridad e integridad

- webhook rechaza secreto incorrecto;
- service-role y credenciales de Management API no llegan al navegador;
- Storage de evidencias no es público;
- RLS/permisos backend coherentes con las migraciones vigentes;
- funciones privilegiadas no quedan ejecutables directamente por clientes cuando su contrato es backend-only;
- no existen evidencias/verificaciones huérfanas;
- no existe más de un Owner;
- no hay asignaciones/dispatch duplicados por reintentos;
- operaciones abortadas no borran historia consolidada del vehículo.

## 16. Smoke test antes de una release real

1. Root y Operario abren la Mini App desde Telegram.
2. Permisos visibles y backend coinciden.
3. Access session 22 h y flow session 20 min se comportan según contrato.
4. Recogida completa con cámara/OCR.
5. Aparcar con GPS y fallback manual.
6. Reubicar con GPS y fallback manual.
7. Buscar con GPS y sin GPS.
8. Entrega con cámara/OCR.
9. Expediente 360º y PDF selectivo.
10. Equipo en vivo y desaparición al dejar de compartir.
11. Gestión/importación de reservas.
12. Asignación manual, `SIN ASIGNAR` y confirmación IA con notificaciones.
13. Optimizer V2 sobre dataset de prueba.
14. Retención/disputa y mantenimiento.
15. Factory Reset en entorno de prueba.
16. Informe de salud/recursos.
17. Stable Release Guard y verificaciones de despliegue aplicables.

Este documento no conserva deudas históricas ya resueltas. Los cambios pasados se consultan en Git.