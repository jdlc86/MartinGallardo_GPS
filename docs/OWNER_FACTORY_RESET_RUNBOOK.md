# Owner Factory Reset — Runbook

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
11. Conserva el Owner y registra el resultado en `factory_reset_runs`.

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
- planes/sesiones de IA y jobs/resultados del optimizador;
- presencia/localización operativa;
- sesiones y solicitudes de acceso operativas;
- auditoría operativa y despachos de informes de rendimiento;
- usuarios no Owner y workers operativos.

## Recuperación ante fallo

Si falla Storage, la base operativa no se purga y el run se marca `failed`. Se genera una nueva preview para reintentar. El borrado físico es idempotente: un objeto ya ausente se considera correctamente eliminado.

Si Storage termina y falla la finalización de base de datos, se genera una nueva preview y se repite. Los objetos ya eliminados devuelven 404 y se consideran éxito; la siguiente finalización puede limpiar los metadatos restantes.

## Seguridad

- solo Owner autenticado mediante Telegram initData o sesión de acceso válida;
- el rol nunca se acepta desde el cliente;
- Edge Function usa service role internamente;
- confirmación fuerte + confirmación visual;
- una sola ejecución `running` simultánea;
- las disputas bloquean por defecto;
- sin `TRUNCATE ... CASCADE` ni eliminación directa de `storage.objects`.
