# Owner Factory Reset — Runbook

## Alcance

El Factory Reset elimina datos operativos de ParkingMartin-G y las evidencias físicas del bucket `vehicle-evidence`.

Conserva configuración, infraestructura, telemetría de plataforma, mantenimiento, el bucket `miniapps` y el Owner que ejecuta el reset.

## Flujo obligatorio

1. El Owner abre `factory-reset.html`.
2. Ejecuta `preview` (dry-run). No se borra nada.
3. Revisa conteos, tamaño de Storage y disputas abiertas.
4. La preview caduca a los 15 minutos y genera un `reset_id` de un solo uso.
5. Para ejecutar debe escribir exactamente `RESET_OPERATIONAL_DATA`.
6. Si existen disputas abiertas, la ejecución queda bloqueada salvo override explícito.
7. El backend adquiere un lock lógico global (`factory_reset_runs.status = running`).
8. Borra objetos físicos mediante Storage API. Nunca borra `storage.objects` por SQL.
9. Solo después elimina metadatos y datos operativos en una transacción de base de datos.
10. Conserva el Owner y registra el resultado en `factory_reset_runs`.

## Datos conservados

- configuración de parking y sectores;
- requisitos de evidencias;
- configuración y matriz de IA;
- configuración de salud y recursos;
- configuración de retención;
- tareas de mantenimiento;
- auditoría de configuración;
- informes de salud/recursos/mantenimiento;
- infraestructura, migraciones, funciones, cron, secretos y buckets;
- `miniapps`;
- Owner ejecutor.

## Datos eliminados

- vehículos, estancias, eventos, evidencias, fotos, OCR y enlaces compartidos;
- sesiones de operación;
- reservas, importaciones, tareas y asignaciones;
- planes/sesiones de IA y jobs del optimizador;
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
