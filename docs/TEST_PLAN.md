# Plan de pruebas de producción

## Objetivo

Validar ParkingMartin-G tal como funciona hoy: Mini App como interfaz principal, Telegram como acceso/ubicación/informes y Supabase como backend.

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

Debe ver:

- Centro de Operaciones;
- Vehículos;
- Actividad reciente;
- Equipo en vivo;
- GPS Pro Diagnóstico;
- Expediente 360º.

No debe ver **Equipo & Accesos**.

Acceder manualmente a `team-v4.html` debe terminar en rechazo backend (`not_admin`).

### Admin

Debe ver Equipo & Accesos y poder administrar excepto Root/self-change.

### Root

Valor interno `owner`, etiqueta visible **Root**. Debe estar protegido frente a baja/degradación/modificación destructiva.

## 4. Solicitudes de acceso

| Caso | Resultado esperado |
|---|---|
| desconocido contacta | `pending` |
| pending <72 h | sigue pending |
| pending vencido | `expired` |
| rejected vuelve a contactar | vuelve a `pending` si no existe cuenta |
| aprobado activo | acceso Mini App |
| bloqueado | sin acceso, no vuelve a pending |
| aprobar operario | usuario activo `operario` |
| aprobar admin | usuario activo `admin` |
| dar de baja | `active=false` |
| reactivar | `active=true` |
| promover | admin |
| degradar | operario |
| tocar Root | rechazado |
| admin se modifica a sí mismo | rechazado |

Invariante: usuario existente en `telegram_users` no debe aparecer pendiente/rechazado/expirado.

## 5. Recogida

- matrícula válida;
- requisitos dinámicos desde `evidence_requirements`;
- cámara integrada para fotos de estado;
- miniaturas visibles;
- borrar una foto reduce contador y elimina Storage/DB;
- documentación imagen;
- documentación PDF;
- borrar documento pendiente;
- foto matrícula + OCR coincide;
- OCR mismatch;
- OCR failed;
- repetir foto;
- override auditado;
- no finalizar si falta evidencia;
- finalizar -> `vehicles.status='in_transit'`;
- un solo evento `pickup`;
- evidencias finalizadas vinculadas al evento.

## 6. Aparcar

- vehículo nuevo/existente válido;
- `normalized_plate` no se envía en INSERT/UPDATE;
- OCR coincide;
- OCR mismatch/failed;
- repetir foto;
- override queda en `plate_verifications`;
- no intenta insertar operación OCR inválida en `parking_events`;
- GPS Pro visible con precisión/calidad;
- precisión bajo umbral -> referencia opcional;
- precisión sobre umbral -> referencia obligatoria;
- confirmar -> `parked` + `park`;
- ubicación/accuracy/parked_at/worker correctos;
- no duplicar aparcado en retry.

## 7. Buscar coche

- solo `parked` devuelve resultado;
- navegación solo con coordenadas válidas;
- `requested/in_transit/retrieved` no son navegables;
- muestra precisión/referencia/operario/fecha;
- registra `lookup`;
- no cambia estado;
- matrícula inexistente controlada.

## 8. Entrega

- solo parte de vehículo `parked`;
- navegación disponible si hay GPS;
- botón inicial dice **Foto Matrícula**;
- después de foto pasa a **Repetir Foto**;
- OCR `parking_exit` coincide;
- mismatch/failed;
- override auditado;
- no cambia estado antes de confirmación final;
- finalizar sin verificación aceptada -> rechazado;
- finalizar -> `retrieved` + evento `retrieve`;
- después no aparece navegación activa.

## 9. Expediente 360º

- vehículo sin evidencias;
- múltiples etapas/días;
- miniaturas y ampliación;
- OCR/overrides visibles;
- historial correcto;
- navegación solo `parked`;
- compartir genera enlace temporal;
- WhatsApp/copia/Telegram funcionan;
- correo abre Gmail correctamente;
- informe PDF con tildes/ortografía;
- URLs firmadas caducan.

## 10. GPS Pro Diagnóstico

- obtiene geolocalización;
- muestra precisión/calidad;
- permite repetir;
- no crea eventos;
- no escribe `vehicles`;
- no escribe tablas GPS operativas.

## 11. Equipo en vivo

### Inicio

- usuario activo comparte ubicación en vivo con el bot;
- primera `message` crea/actualiza una fila en `worker_live_locations`;
- mapa la muestra.

### Actualizaciones

- `edited_message` mueve el punto;
- cambio insignificante <10 s + <5 m + sin mejora de precisión puede omitirse;
- cambio relevante actualiza fila;
- sigue existiendo una sola fila por usuario.

### Fin

- pulsar **Dejar de compartir** y recibir edición de fin -> fila eliminada;
- marcador desaparece en el siguiente refresco;
- si Telegram no informa el final, posiciones >30 min dejan de mostrarse;
- `worker_daily_presence` conserva el `sí` diario aunque la fila live se elimine.

### Visibilidad

- operario activo puede ver mapa;
- admin puede ver mapa;
- Root puede ver mapa;
- usuario inactivo/no autorizado no obtiene datos.

No debe existir historial de trayectoria.

## 12. Informes automáticos

Zona horaria: Europe/Madrid.

Probar mediante ejecución controlada:

- hora 04 -> día anterior;
- hora 13 -> día actual;
- hora 20 -> día actual;
- otra hora -> `skipped`;
- cada operario recibe resumen individual;
- Root/Admin reciben global además del individual si tienen actividad como worker;
- conteos pickup/park/lookup/retrieve correctos;
- OCR overrides correctos;
- primera/última actividad correctas;
- presencia diaria correcta;
- retry mismo slot -> sin duplicado por `performance_report_dispatches`;
- fallo de Telegram -> reserva se elimina para permitir reintento.

## 13. Seguridad

- webhook rechaza secret incorrecto;
- Mini App rechaza `initData` inválido/expirado;
- service-role no está en HTML/JS;
- Storage no es público;
- operario no ejecuta admin actions;
- Root protegido en DB;
- grupo no ejecuta lógica privada;
- `get_daily_performance_report` no ejecutable por `anon/authenticated`;
- `mark_worker_daily_presence` no ejecutable por `anon/authenticated`.

### Deuda que debe mantenerse visible

- `plate_verifications` sin RLS;
- vista `telegram_access_requests_visible_rejected` security-definer;
- `expire_pending_access_requests()` con permisos/security-definer a revisar;
- funciones históricas de acceso con search_path mutable.

## 14. Integridad de datos

Consultas periódicas:

- usuarios activos con solicitud != approved = 0;
- bloqueados con pending = 0;
- más de un `owner` = 0;
- `normalized_plate` consistente con `plate`;
- evidencias sin vehículo = 0;
- verificaciones sin vehículo = 0;
- navegación activa de vehículo no parked = 0;
- más de una fila live por usuario = 0;
- dispatch duplicado por fecha/hora/destinatario/scope = 0.

## 15. Carga

Escenario mínimo:

- ~150 vehículos/día;
- 30 días;
- múltiples evidencias por recogida;
- varios usuarios compartiendo ubicación;
- mapa abierto durante turnos.

Medir:

- búsqueda por matrícula;
- listado parked;
- Expediente 360º;
- panel Equipo & Accesos;
- API Equipo en vivo;
- generación informe diario.

## 16. Smoke test de release

1. Root `/start` -> única entrada Mini App;
2. operario `/start` -> misma entrada;
3. operario no ve Equipo & Accesos;
4. Root ve Equipo & Accesos con etiqueta Root;
5. Recogida completa con evidencias/OCR;
6. Aparcar con OCR + GPS;
7. Buscar + navegación;
8. Entrega + OCR salida;
9. Expediente 360º;
10. compartir ubicación y verla en Equipo en vivo;
11. dejar de compartir y comprobar desaparición;
12. prueba group guard;
13. prueba controlada de informe;
14. comprobar advisors de seguridad.
