# AGENTS.md — Reglas de mantenimiento

Este archivo define cómo modificar **ParkingMartin-G** sin reintroducir comportamiento antiguo ni romper el estado estable.

## Fuente de verdad

Orden de autoridad:

1. código y migraciones de `main`;
2. `release/manifest.json` para identificación de release;
3. documentación vigente.

Si un documento contradice la implementación, corregir el documento. No conservar handoffs, auditorías cerradas ni instrucciones de transición obsoletas dentro de la documentación activa.

## Prioridades

1. seguridad y permisos;
2. integridad de datos;
3. Mini App como interfaz operativa;
4. trazabilidad;
5. idempotencia y pruebas;
6. simplicidad operativa.

## Interfaz y Telegram

La interfaz operativa es `docs/preview-modern/`. El bot privado orienta/abre la Mini App, recibe ubicación en vivo y entrega notificaciones/informes según el backend vigente.

- No reintroducir menús operativos Recogida/Aparcar/Reubicar/Buscar/Entrega en el chat.
- `telegram-gateway` es el webhook operativo.
- En `group`/`supergroup` no ejecutar operaciones privadas, registrar ubicación ni crear sesiones.

## Roles

Roles internos: `owner`, `admin`, `operario`.

- Mostrar `owner` como **Root**.
- Solo puede existir un Owner.
- Root permanece activo/protegido.
- Admin no modifica Root ni sus propios permisos protegidos.
- Operario no ejecuta funciones ADMIN.
- El backend siempre revalida autorización; ocultar UI no es una medida de seguridad suficiente.

## Sesiones

- Telegram `initData`: bootstrap máximo 10 minutos.
- Access session backend: 22 horas, opaca/revocable.
- Flow sessions protegidas de Recogida, Aparcar, Reubicar y Entrega: 20 minutos.
- Buscar coche es consulta autenticada, sin flow session equivalente.
- No reutilizar tokens cacheados entre usuarios Telegram.
- Una operación pendiente recuperable exige decisión explícita antes de continuar/iniciar otra.

## Flujos vigentes

### Recogida

Matrícula → evidencias → matrícula/OCR → documentación → finalizar. Requisitos dinámicos desde `evidence_requirements`; override OCR auditado; finaliza `in_transit` + `pickup`.

### Aparcar

Matrícula/OCR → GPS o referencia manual → confirmar. `normalized_plate` es generado por DB; finaliza `parked` + `park`.

### Reubicar

Opera sobre vehículo existente, protege el contexto frente a cambios concurrentes y actualiza ubicación GPS/manual sin borrar historia previa.

### Buscar

Solo `parked`; navegación solo con coordenadas reales; si no existen se muestra referencia manual. Registra `lookup` y no cambia estado.

### Entrega

Vehículo `parked` → matrícula/OCR `parking_exit` → confirmar; finaliza `retrieved` + `retrieve`.

## Cámara, OCR y evidencias

- Cámara embebida vigente en los flujos que capturan fotografías; mantener comportamiento vertical/horizontal y torch cuando sea soportado.
- OCR activo en `airport_pickup`, `parking` y `parking_exit`.
- Resultados/overrides en `plate_verifications`.
- Evidencias vigentes en `vehicle_evidence` y Storage privado `vehicle-evidence`.
- No desarrollar nuevas funciones sobre `vehicle_photos` salvo migración explícita.
- Usar URLs firmadas temporales.

## GPS y Equipo en vivo

- GPS operativo integrado en los flujos; cuando el contrato lo permita, ausencia/baja precisión usa referencia manual.
- `gps-diagnostic.html` es diagnóstico y no modifica vehículos.
- No reintroducir sectorización operativa salvo una nueva decisión de producto respaldada por código/migración.
- Equipo en vivo usa Telegram Live Location, una fila vigente por usuario y sin trayectoria histórica.
- Al dejar de compartir, la posición debe desaparecer; `worker_daily_presence` conserva presencia diaria para informes.

## Reservas y asignación

- Gestión de reservas permanece protegida por backend.
- Mantener control de versión, idempotencia e importación consistente.
- Asignación manual notifica al operario.
- `SIN ASIGNAR` es una opción operativa vigente.
- Confirmar el Asistente IA aplica el plan y genera notificaciones de asignación/reasignación.
- No duplicar en frontend notificaciones que el contrato transaccional backend ya genera.

## Optimizer V2

- `solve()` representa Fase 1 estable.
- Fast y Optimal son modos del rolling horizon continuo 24/7.
- No introducir fronteras artificiales por día.
- No aceptar planes con errores de `validate_solution()`.
- Fase 2 permanece separada/experimental y nunca puede degradar cobertura global al promoverse.
- `optimization_jobs` es fuente durable; Realtime solo señaliza.
- Worker fuera de Edge Functions; secretos solo en entorno servidor.
- No commitear `.env`, benchmarks generados ni cachés Python.

## Retención y Factory Reset

- Entorno actual: pruebas sin usuarios reales.
- Retención efectiva temporal: 5 minutos para validar mantenimiento.
- Política prevista antes de usuarios reales: 15 días.
- Disputa abierta protege frente a purga.
- Factory Reset solo Root; no debe borrar identidad/configuración técnica necesaria ni historia fuera de su contrato.

## Observabilidad

- Informe diario de salud a Root/Admin a medianoche de Madrid según implementación vigente.
- PostgreSQL/Storage se miden directamente.
- API Requests y Edge Function Invocations se obtienen desde backend/Management API cuando estén disponibles.
- Egress permanece fuera del alcance actual.
- No convertir métricas en puntuaciones subjetivas ni límites de proveedor sin decisión explícita.

## Identidad, idempotencia y seguridad

Coexisten `telegram_users` y `workers`; no crear una tercera identidad sin migración explícita que preserve FKs/historial.

Telegram y HTTP pueden reintentar. Diseñar efectos idempotentes para acceso, admin actions, evidencias, OCR/override, operaciones de vehículo, reservas/asignaciones y ubicación live.

Nunca:

- commitear secretos;
- exponer service-role/Management API al navegador;
- confiar en username como identidad;
- abrir Storage de evidencias públicamente;
- permitir acciones ADMIN sin revalidación DB;
- aceptar `initData` sin HMAC/edad;
- procesar lógica privada en grupos.

Mantener RLS/permisos/RPC privilegiados conforme a las migraciones vigentes. No documentar como deuda problemas de seguridad ya corregidos; verificar el estado actual antes de crear nueva deuda.

## Cambios de esquema

Antes de DDL:

1. inspeccionar esquema real;
2. crear migración mínima;
3. verificar invariantes/datos;
4. ejecutar comprobaciones de seguridad/rendimiento aplicables;
5. actualizar documentación si cambia el contrato.

## Pruebas y release

Ver `docs/TEST_PLAN.md` y `docs/STABLE_RELEASE.md`.

Baseline identificada por `release/manifest.json`; actualmente Mini App **1.4.0 / 2026.09.11.02**.

- No cambiar silenciosamente interfaz, permisos, contratos backend o semántica del optimizador.
- Cambios visibles/funcionales actualizan build/cache cuando el contrato de release lo requiera.
- Backend/worker actualizan su sello cuando corresponda.
- Stable Release Guard debe pasar cuando los paths/contratos protegidos lo requieran.
- No desplegar una fuente distinta de la versionada en Git.
- Fase 2 no entra en el camino estable sin decisión explícita y pruebas de no regresión.

## No reintroducir

- UI operativa mediante menús del bot;
- nombres visibles Owner/OWNER;
- trayectorias históricas de trabajadores;
- navegación de vehículos no `parked`;
- URLs públicas permanentes de evidencias;
- documentación histórica como si fuese estado vigente.
