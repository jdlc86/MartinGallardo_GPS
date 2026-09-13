# Owner Factory Reset — Runbook

Última auditoría: 2026-09-13

## Alcance

El Factory Reset deja la instalación preparada para ser reutilizada por otro parking.

Elimina los datos de negocio y las evidencias físicas del parking anterior, conserva la configuración técnica del producto y el Owner que ejecuta el reset, y reinicia la configuración física del recinto para impedir que el nuevo parking herede geometría o sectores antiguos.

## Flujo obligatorio

1. El Owner abre `factory-reset.html`.
2. Ejecuta `preview` (dry-run). No se borra nada.
3. Revisa conteos, tamaño de Storage, sectores del parking y disputas abiertas.
4. La preview caduca a los 15 minutos y genera un `reset_id` de un solo uso.
5. Para ejecutar debe escribir exactamente `RESET_OPERATIONAL_DATA`.
6. Si existen disputas abiertas, la ejecución queda bloqueada salvo override explícito.
7. El backend adquiere un lock lógico global (`factory_reset_runs.status = running`).
8. Borra objetos físicos mediante Storage API. Nunca borra `storage.objects` por SQL.
9. Solo después elimina metadatos y datos operativos en una transacción de base de datos.
10. Elimina los sectores del parking anterior y devuelve `parking_config` a estado no configurado.
11. Conserva el Owner, reconstruye el estado estructural de permisos de reservas y registra el resultado en `factory_reset_runs`.

## Invariante Owner / Gestión de reservas

`parking_booking_write_state` contiene estado estructural necesario para Gestión de reservas. Aunque su contenido operativo se limpia durante el reset, al finalizar correctamente debe existir el singleton `id=1` con el Owner preservado como `holder_telegram_user_id` y `granted_by_telegram_user_id`.

Por tanto, después de Factory Reset:

- el Owner conserva acceso a Gestión de reservas;
- el Owner es el titular inicial de Lectura/Escritura;
- el dashboard de reservas no debe devolver `permission=null` por ausencia del singleton;
- la escritura puede transferirse posteriormente mediante el flujo normal de permisos.

Esta reconstrucción quedó incorporada en PR #107 después de detectar en prueba real el error `Cannot read properties of null (reading 'can_write')` tras un reset.

## Configuración técnica conservada

- requisitos de evidencias;
- configuración del optimizador / IA;
- nodos y matriz logística actuales del producto;
- configuración de salud y recursos;
- configuración de retención;
- tareas de mantenimiento;
- auditoría de configuración;
- informes de salud/recursos/mantenimiento;
- infraestructura, migraciones, funciones, cron, secretos y buckets;
- `miniapps`;
- Owner ejecutor.

## Configuración de instalación reiniciada

- `parking_config`: queda con nombre genérico `Parking`, `configured=false`, sin centro GPS ni notas y con umbral de precisión por defecto;
- `parking_sectors`: se eliminan todos los sectores del recinto anterior.

El nuevo parking debe completar de nuevo su configuración física antes de operar.

## Datos eliminados

- vehículos, estancias, eventos, evidencias, fotos, OCR y enlaces compartidos;
- disputas e históricos operativos;
- sesiones de operación;
- reservas, importaciones, tareas y asignaciones;
- estado operativo previo de permisos de reservas (el singleton estructural se reconstruye para el Owner al finalizar);
- planes/sesiones de IA y jobs/resultados del optimizador;
- presencia/localización operativa;
- sesiones y solicitudes de acceso operativas;
- auditoría operativa y despachos de informes de rendimiento;
- usuarios no Owner y workers operativos.

## Recuperación ante fallo

Si falla Storage, la base operativa no se purga y el run se marca `failed`. Se genera una nueva preview para reintentar. El borrado físico es idempotente: un objeto ya ausente se considera correctamente eliminado.

Si Storage termina y falla la finalización de base de datos, se genera una nueva preview y se repite. Los objetos ya eliminados devuelven 404 y se consideran éxito; la siguiente finalización puede limpiar los metadatos restantes.

Incidencia validada 2026-09-12: una primera finalización falló porque el guard de borrado seguro rechazó `DELETE` sin `WHERE`; Storage ya había eliminado los objetos operativos. PR #106 adaptó las eliminaciones globales a `WHERE true` sin alterar el orden ni el alcance. El reintento posterior completó correctamente.

## Validación real 2026-09-12/13

Tras ejecutar el reset corregido y auditar producción:

- `vehicles=0`;
- `vehicle_stays=0`;
- `vehicle_evidence=0`;
- `vehicle_photos=0`;
- `parking_events=0`;
- `parking_bookings=0`;
- `reservation_tasks=0`;
- `operation_flow_sessions=0`;
- `optimization_jobs=0`;
- `parking_sectors=0`;
- exactamente un Owner preservado;
- `parking_config.configured=false`;
- `parking_booking_write_state.id=1` reconstruido y referenciando al Owner;
- cero referencias inválidas en el estado de escritura de reservas;
- Storage quedó con un único objeto técnico: `miniapps/location/index.html`, 2473 bytes; no quedaron evidencias de vehículos.

La base PostgreSQL permaneció alrededor de 24.8 MiB. Esto es esperado: Factory Reset elimina datos lógicos, pero PostgreSQL conserva estructura, índices, extensiones y páginas reutilizables. El tamaño físico no debe utilizarse por sí solo como criterio de éxito del reset.

Las tuplas muertas que aparezcan tras una limpieza grande tampoco significan datos operativos activos; son versiones de filas pendientes de recuperación/reutilización por VACUUM/autovacuum.

## Seguridad

- solo Owner autenticado mediante Telegram initData o sesión de acceso válida;
- el rol nunca se acepta desde el cliente;
- Edge Function usa service role internamente;
- confirmación fuerte + confirmación visual;
- una sola ejecución `running` simultánea;
- las disputas bloquean por defecto;
- sin `TRUNCATE ... CASCADE` ni eliminación directa de `storage.objects`;
- GitHub `main` es fuente de verdad; cambios de implementación pasan por PR y Stable Release Guard antes de producción.
