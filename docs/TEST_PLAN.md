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
