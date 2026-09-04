# Plan de pruebas de producción

## Objetivo

Validar ParkingMartin-G tal como funciona hoy: Mini App como interfaz principal, Telegram como acceso/ubicación/notificaciones/informes y Supabase como backend.

## 1. Entrada Telegram

- usuario activo `/start` -> bienvenida + único botón **ABRIR PARKINGMARTIN-G**;
- mensaje normal de usuario activo -> orientación breve + acceso a Mini App;
- no aparece menú antiguo Recogida/Aparcar/Buscar/Entrega;
- callback histórico -> no inicia flujo clásico; orienta a Mini App;
- botón permanente de menú Telegram abre ParkingMartin-G;
- webhook de producción apunta a `telegram-gateway`.

## 2. Protección de grupos

Probar `group` y `supergroup`:

- mensaje normal -> ignorado;
- ubicación -> ignorada;
- `/start` -> no inicia flujo privado;
- callback histórico -> aviso neutro sin acción de dominio;
- no se crea sesión;
- no se crea/actualiza `worker_live_locations`;
- no se reenvía al backend operativo.

## 3. Roles y acceso a Mini App

### Operario

Debe ver Centro de Operaciones, Vehículos, Actividad reciente, Equipo en vivo, GPS Pro Diagnóstico y Expediente 360º. No debe ver **Equipo & Accesos**.

Acceso directo a Equipo & Accesos debe ser rechazado por backend, pero la UI **no debe mostrar `not_admin`**: debe explicar que no tiene permisos.

### Admin

Debe ver Equipo & Accesos y poder administrar excepto Root/self-change.

### Root

Valor interno `owner`, etiqueta visible **Root**. Debe estar protegido frente a baja/degradación/modificación destructiva.

Gestión de reservas debe permanecer oculta para Operario. Un acceso directo a la página o API debe ser rechazado por backend.

## 4. Solicitudes, altas y cambios de rol

| Caso | Resultado esperado |
|---|---|
| desconocido contacta | `pending` |
| pending <72 h | sigue pending |
| pending vencido | `expired` |
| rejected vuelve a contactar | vuelve a `pending` si no existe cuenta |
| aprobar operario | activo `operario` + bienvenida automática + rol Operario |
| aprobar admin | activo `admin` + bienvenida automática + rol Admin |
| dar de baja | `active=false` |
| reactivar | `active=true` + bienvenida de regreso + rol actual |
| promover | admin + aviso automático de nuevo rol Admin |
| degradar | operario + aviso automático de nuevo rol Operario |
| tocar Root | rechazado |
| admin se modifica a sí mismo | rechazado |

Verificar que todos los mensajes incluyen botón **ABRIR PARKINGMARTIN-G** cuando corresponde y que nunca muestran `owner` al usuario; debe verse **Root**.

## 5. Sesión administrativa e `initData`

- `initData` con firma inválida -> rechazado;
- `auth_date` válido dentro de 24 h -> aceptado;
- panel abierto >15 min y <24 h -> sigue funcionando;
- `auth_date` >24 h -> rechazado;
- usuario que pierde rol Admin mientras tiene pantalla abierta -> siguiente acción rechazada;
- usuario desactivado mientras tiene pantalla abierta -> siguiente acción rechazada;
- sesión caducada debe mostrarse como mensaje amigable: cerrar y reabrir ParkingMartin-G desde Telegram;
- nunca mostrar literalmente `expired_init_data`, `invalid_init_data` o `not_admin`.

## 6. Política de errores UX

Probar en las pantallas de producción:

- sin Internet;
- timeout/fallo 5xx;
- respuesta no JSON;
- sesión caducada;
- usuario no autorizado;
- permisos insuficientes;
- estado de vehículo cambiado;
- matrícula inválida;
- foto/archivo inválido;
- GPS insuficiente.

Además:

- repetir sin Internet en Día, Noche y Automático: el aviso debe usar el tema resuelto y no puede duplicarse;
- en móvil, `Auto/Día/Noche`, campana y aviso de conectividad no se solapan.

Resultado esperado: mensaje en español, comprensible y accionable. No mostrar:

- `ERROR:`;
- `JS ERROR:`;
- stack traces;
- SQL/PostgREST crudo;
- códigos HTTP como explicación principal;
- códigos internos (`expired_init_data`, `state_changed`, etc.).

El detalle técnico puede permanecer en consola/logs.

## 7. Recogida

- matrícula válida;
- requisitos dinámicos;
- cámara para fotos de estado;
- la vista previa solo habilita **Capturar** después de recibir un fotograma real;
- si la cámara trasera con resolución preferida no inicia, reintenta con restricciones simples sin dejar una pantalla negra;
- permiso denegado, cámara ocupada o ausencia de fotogramas muestran un mensaje claro y permiten reintentar;
- cancelar o cambiar de intento detiene todas las pistas de vídeo activas;
- «Ver guía de fotos» abre un diálogo centrado y muestra completa la guía SVG sin deformación;
- la guía cabe en móvil vertical y horizontal, permite cerrar con botón, fondo o Escape y respeta Día/Noche;
- la guía queda disponible desde la caché offline del shell;
- miniaturas visibles;
- borrado individual de evidencia;
- documentación imagen/PDF;
- foto matrícula + OCR;
- mismatch/failed/repetir/override;
- no finalizar si falta evidencia;
- finalizar -> `in_transit` + un solo `pickup`.

## 8. Aparcar

- vehículo nuevo/existente válido;
- `normalized_plate` no se escribe;
- OCR coincide/mismatch/failed;
- repetir/override;
- GPS Pro visible con precisión/calidad;
- precisión sobre umbral -> referencia obligatoria;
- confirmar -> `parked` + `park`;
- no duplicar en retry.

## 9. Buscar coche

- solo `parked` devuelve resultado;
- navegación solo con coordenadas válidas;
- otros estados no navegables;
- muestra precisión/referencia/operario/fecha;
- registra `lookup` sin cambiar estado;
- matrícula inexistente controlada con mensaje amigable.

## 10. Entrega

- parte de `parked`;
- navegación si hay GPS;
- botón **Foto Matrícula** -> **Repetir Foto**;
- OCR `parking_exit`;
- mismatch/failed/override;
- no cambia estado antes de confirmación;
- finalizar -> `retrieved` + `retrieve`.

## 11. Expediente 360º

- vehículo sin evidencias;
- múltiples etapas/días;
- miniaturas/ampliación;
- OCR/overrides visibles;
- historial en español (`pickup`, `park`, `lookup`, `retrieve` no deben aparecer como textos crudos);
- estados visibles en español y pill centrado;
- navegación solo `parked`;
- compartir temporal;
- WhatsApp/copia/Telegram/correo;
- PDF con tildes/ortografía;
- URLs firmadas caducan.

## 12. GPS Pro Diagnóstico

- obtiene geolocalización;
- muestra precisión/calidad;
- permite repetir;
- no crea eventos ni modifica vehículos.

## 13. Equipo en vivo

- primera `message` crea/actualiza fila;
- `edited_message` actualiza posición;
- cambios insignificantes pueden omitirse;
- una sola fila por usuario;
- **Dejar de compartir** elimina fila al recibir edición de fin;
- fallback >30 min deja de mostrar;
- `worker_daily_presence` conserva presencia diaria;
- visible para cualquier usuario activo;
- no existe trayectoria histórica.

## 14. Informes automáticos

Zona horaria Europe/Madrid:

- 04 -> día anterior;
- 13 -> día actual;
- 20 -> día actual;
- otra hora -> skipped;
- informe individual por operario;
- Root/Admin global además del individual cuando corresponda;
- conteos y OCR correctos;
- primera/última actividad;
- presencia diaria;
- retry sin duplicado.

## 15. Seguridad

- webhook rechaza secret incorrecto;
- Mini App rechaza firma `initData` inválida;
- vigencia administrativa máxima 24 h;
- service-role no está en HTML/JS;
- Storage no es público;
- operario no ejecuta admin actions;
- Root protegido en DB;
- grupo no ejecuta lógica privada;
- funciones de reporting no ejecutables por cliente.

### Deuda visible

- `plate_verifications` sin RLS;
- vista `telegram_access_requests_visible_rejected` security-definer;
- `expire_pending_access_requests()` a revisar;
- funciones históricas con search_path mutable.

## 16. Integridad de datos

- usuarios activos con solicitud != approved = 0;
- bloqueados con pending = 0;
- más de un `owner` = 0;
- `normalized_plate` consistente;
- evidencias/verificaciones sin vehículo = 0;
- navegación activa de no parked = 0;
- más de una fila live por usuario = 0;
- dispatch duplicado = 0.

## 17. Carga

Escenario mínimo: ~150 vehículos/día, 30 días, múltiples evidencias, varios usuarios compartiendo ubicación y mapa abierto durante turnos.

Medir búsqueda por matrícula, listado parked, Expediente 360º, Equipo & Accesos, Equipo en vivo e informes.

## 18. Smoke test de release

1. Root `/start` -> única entrada Mini App;
2. operario `/start` -> misma entrada;
3. operario no ve Equipo & Accesos;
4. Root ve Equipo & Accesos con etiqueta Root;
5. aprobar usuario -> recibe bienvenida y rol automáticamente;
6. reactivar usuario -> recibe bienvenida de regreso;
7. promover/degradar -> recibe aviso de rol;
8. dejar panel abierto >15 min y comprobar que sigue administrando;
9. forzar error conocido y comprobar mensaje amigable sin código técnico;
10. Recogida completa;
11. Aparcar con OCR + GPS;
12. Buscar + navegación;
13. Entrega + OCR salida;
14. Expediente 360º en español;
15. Equipo en vivo + dejar de compartir;
16. group guard;
17. informe controlado;
18. advisors de seguridad.

## 19. Gestión administrativa de reservas

### Roles y permisos

- Operario no ve la tarjeta y la API devuelve acceso denegado;
- Root/Admin con Lectura puede consultar y buscar, pero no crear, editar, importar ni eliminar;
- el titular ve **Lectura / Escritura** y puede mutar;
- cada petición vuelve a comprobar rol activo, titular y época de escritura.

### CRUD y búsqueda

- alta manual con todos los campos;
- modificación incrementa `version`;
- actualización con versión antigua -> conflicto sin sobrescritura;
- búsqueda por usuario, e-mail, teléfono, matrícula, marca/modelo, terminal o fecha;
- borrado individual lógico conserva auditoría;
- borrado masivo de hasta 200 filas es atómico;
- reintento con la misma clave idempotente no duplica efectos.

### Escritura exclusiva

- Root es titular inicial;
- Admin de Lectura solicita escritura y el titular recibe campana + Telegram;
- aceptar transfiere el permiso, incrementa `epoch` e invalida pantallas antiguas;
- rechazar conserva el titular;
- el titular ofrece una transferencia y el destinatario debe aceptar/rechazar;
- solicitudes pendientes caducan al cambiar el titular;
- degradar o bloquear al titular recupera el permiso para otro administrador activo.

### Retención de notificaciones

- un aviso leído con más de 30 días no aparece en la campana;
- un aviso no leído continúa visible hasta que se atiende o alcanza 90 días;
- `parking_booking_cleanup_notifications()` elimina avisos con más de 90 días;
- el Cron diario `cleanup-reservation-notifications` está activo;
- limpiar avisos no elimina `parking_booking_permission_requests` ni `parking_booking_admin_events`.

### Programador y asignación de tareas

- una reserva pendiente (`requested` o sin vehículo actualmente bajo custodia) genera Recogida y Entrega con horario `Europe/Madrid`;
- una reserva cuyo vehículo ya está `in_transit` o `parked` genera o conserva únicamente la Entrega;
- una recogida anticipada completa automáticamente la tarea de Recogida pendiente, mantiene la Entrega y conserva el registro completado para auditoría;
- volver a sincronizar una reserva pendiente mantiene activas sus dos tareas sin duplicarlas;
- Root/Admin puede filtrar, seleccionar un día completo y asignar en bloque a Root, Admin u Operario activo;
- una versión desactualizada devuelve `task_assignment_conflict` sin sobrescribir la asignación nueva;
- una reasignación conserva responsable anterior, nuevo responsable, actor y fecha en el historial;
- Centro de Operaciones muestra la cantidad y la próxima hora solo en Recogida aeropuerto y Entrega al cliente cuando el usuario tiene tareas asignadas;
- Recogida y Entrega muestran exclusivamente las tareas `assigned` del usuario autenticado, ordenadas de menor a mayor por fecha y hora;
- al abrir una tarea aparecen terminal, cliente, contacto, vehículo, precio, pago y la fecha relacionada de regreso o recogida;
- iniciar una tarea precarga la matrícula y continúa por el botón y la API del flujo habitual, sin registrar todavía la tarea como completada;
- asignar crea un único aviso persistente para el nuevo responsable y otro para cada responsable sustituido;
- la campana recibe la señal Realtime y no mantiene temporizadores de consulta periódica;
- el listado operativo reutiliza el evento `pmg:reservation-task-change` y no abre un segundo canal Realtime;
- abrir la Mini App, recuperar Internet o volver al primer plano reconcilia los avisos una sola vez;
- una desconexión real muestra una nota compacta que cambia a “Conexión restablecida” y desaparece automáticamente al volver la red;
- un fallo puntual de red con el dispositivo aún conectado muestra “Conexión inestable” de forma temporal y una petición posterior exitosa retira el estado de desconexión en cualquier vista;
- la gestión de reservas se recarga por eventos y no mantiene el antiguo sondeo de 20 segundos;
- el aviso ofrece acceso directo a Mis tareas y permite marcar todo como leído de forma explícita;
- Telegram registra `telegram_sent_at` cuando acepta el mensaje y conserva `telegram_error` cuando falla;
- una respuesta temporal de Telegram se reintenta hasta tres veces dentro de la ejecución activada por el aviso;
- un fallo no se reintenta antes de cinco minutos ni supera ocho intentos;
- no existe el Cron `deliver-reservation-notifications`;
- insertar un aviso activa una única llamada asíncrona al repartidor, autenticada mediante Vault;
- dos ejecuciones simultáneas del repartidor no duplican entregas por el bloqueo `skip locked`;
- desactivar a un responsable devuelve sus tareas pendientes a Sin asignar y crea el aviso correspondiente.
- al seleccionar la última tarea en móvil, la barra de asignación reserva su altura real y mantiene la fila seleccionada completamente visible por encima del panel.

### Importación con IA

- acepta `.xlsx`, `.csv` y `.tsv` hasta 6 MB;
- Gemini recibe solo encabezados saneados, nunca filas con datos personales;
- fechas Mes-Día-Año se normalizan a fecha ISO;
- Efectivo/Tarjeta se normalizan sin inventar valores;
- previsualiza filas válidas e incidencias antes de guardar;
- permite excluir filas válidas;
- análisis caduca a las 2 horas;
- reimportar exactamente el mismo archivo no duplica reservas;
- commit comprueba de nuevo titular y `epoch`;
- sin IA configurada, la importación se bloquea y el alta manual sigue disponible.

## 20. Optimizer V2

### Cola y worker

- pulsar **Optimizar** crea un job y responde sin esperar al solver;
- solo el usuario que lo lanza recibe el aviso de Telegram correspondiente;
- worker Docker reclama el job y cambia `pending -> running -> succeeded/failed`;
- no hay polling periódico en la Mini App;
- perder un evento Realtime no pierde el resultado: al reabrir/volver a primer plano se reconcilia una vez;
- mientras el job está `pending/running`, **Optimizar** y **Nueva optimización** permanecen bloqueados;
- no aparece un chip global redundante de “optimizando/terminado”.

### Preflight automático de rutas

- la interfaz no muestra botón manual **Actualizar trayectos**;
- pulsar **Optimizar** prepara primero los trayectos necesarios;
- solo se refrescan las franjas/terminales necesarios para el horizonte;
- con Google disponible, la fuente preferente es `google_routes`;
- si Google falla y existe caché reciente, se reutiliza;
- si la caché es antigua, se aplica penalización conservadora antes de lanzar el solver;
- si falta una relación, se usa baseline disponible o estimación dinámica por coordenadas;
- no se crea el job si después del fallback sigue faltando una ruta requerida;
- el resultado del preflight queda registrado en `optimization_jobs.request.route_preflight`;
- probar una optimización con worker 2.1.1 y confirmar 0 errores físicos.

### Propuesta

- una propuesta `succeeded` carga sus asignaciones y logística;
- cada operario aparece en bloque expandible/contraíble;
- el texto respeta el ancho de móvil vertical y no produce scroll horizontal;
- se muestran transferencias entre terminales, acompañamientos y coche/lanzadera cuando proceda;
- se muestra el total de tareas asignadas y las pendientes de organizar manualmente;
- no se muestran al cliente códigos internos de auditoría;
- **Rechazar** oculta la propuesta y esta no vuelve a aparecer al reabrir la pantalla;
- confirmar/rechazar nunca reutiliza una propuesta con estado distinto de `proposal`.

### Fase 1

- Fast benchmark: 221/300 o superior con 0 errores físicos;
- Optimal benchmark: 223/300 o superior con 0 errores físicos;
- `validate_solution()` debe devolver 0 errores antes de persistir un plan válido;
- no reintroducir fronteras por día;
- descansos y máximos de jornada se validan en línea temporal continua;
- tareas manuales no cambian de operario;
- ninguna tarea asignada puede quedar con traslado físico no resuelto.

### Rendimiento

- registrar `elapsed_seconds`, número de tareas y cobertura;
- comparar 60/90/120 s sobre un dataset idéntico antes de cambiar el límite de producción;
- hacer benchmark de una semana completa realista antes de decidir el límite definitivo;
- comprobar que los logs Docker no crecen sin límite.

### Fase 2 experimental

- partir siempre del resultado aceptado de Fase 1;
- no aceptar ninguna reparación con menor cobertura;
- toda reparación reconstruida debe pasar el validador global;
- medir tareas recuperadas, `not_proven` restantes, `proven_unavailable`, tiempo extra, mejoras reales y swaps seguros;
- si no se demuestra una reparación válida, conservar `not_proven`.

## 21. Release baseline 1.4.0 / 2026.09.04.02

Antes de promover un build posterior:

- la home conserva los grupos Operación / Gestión / Sistema;
- las etiquetas funcionales coinciden con `docs/STABLE_RELEASE.md`;
- tarjetas `ADMIN` permanecen ocultas para Operario y sus APIs rechazan acceso no autorizado;
- Root no aparece en asignación manual ni en participantes del reparto;
- tareas manuales siguen siendo constraints duras;
- participantes excluidos no reciben tareas nuevas;
- Información del sistema muestra versión/build coherentes;
- el Service Worker no sirve una home anterior tras actualizar el build;
- Fase 1 mantiene 0 errores físicos;
- Fase 2 no altera `solve()` estable.

### Validación funcional 2026-09-04

Smoke test de producción completado tras endurecer `plate_verifications`:

- Recogida: OK
- Aparcar: OK
- Buscar: OK
- Entrega: OK
- Expediente 360º: OK

El Security Advisor ya no reporta `rls_disabled_in_public` para `plate_verifications`. El aviso restante `rls_enabled_no_policy` es informativo y coherente con el diseño backend-only: no existen políticas cliente y `anon/authenticated` no tienen privilegios directos sobre la tabla.
