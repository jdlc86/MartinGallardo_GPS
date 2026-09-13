# ParkingMartin-G — Release estable vigente

## Fuente canónica

La release estable se define por `release/manifest.json`. Este documento describe el contrato funcional vigente; no mantiene cronologías de builds anteriores. Si existe una contradicción, prevalecen el código, las migraciones y el manifest de `main`.

## Identificación actual

- Producto: **ParkingMartin-G**
- Versión Mini App: **1.4.0**
- Build estable: **2026.09.11.02**
- Service Worker: **pmg-shell-v108**
- Backend: **1.4.0 / 2026.09.04.04**
- Optimizer: **2.1.2 / 2026.09.04.04**
- Rama estable: `main`

Los identificadores anteriores deben mantenerse sincronizados con `release/manifest.json`; no se duplican aquí attestations ni inventarios que ya pertenecen al manifest.

## Arquitectura operativa

- Mini App vigente: `docs/preview-modern/`.
- Telegram proporciona entrada, identidad bootstrap, ubicación en vivo y notificaciones.
- Supabase proporciona persistencia, autenticación backend, Edge Functions, Realtime y mantenimiento.
- `optimization_jobs` es la fuente durable del optimizador; Realtime solo señaliza cambios.
- El worker Optimizer V2 se ejecuta fuera de Edge Functions.

## Sesiones

- `initData` de Telegram: bootstrap máximo **10 minutos**.
- Access session backend: **22 horas**, opaca y revocable.
- Flow session de Recogida, Aparcar, Reubicar y Entrega: **20 minutos**.
- Buscar coche es una consulta autenticada y no crea una flow session equivalente.
- La sesión cacheada debe estar vinculada al usuario Telegram actual y no puede reutilizarse entre identidades.
- Una operación recuperable exige elección explícita entre continuar o iniciar otra; iniciar otra cancela primero la sesión pendiente en backend.

## Roles y permisos

- Roles internos: `owner`, `admin`, `operario`.
- `owner` se presenta como **Root**.
- Root está protegido frente a baja/degradación destructiva.
- Operario no accede a funciones ADMIN.
- Ocultar controles nunca sustituye la autorización servidor.
- Root/Owner no aparece como trabajador asignable.

## Operaciones de vehículo

### Recogida

Matrícula → evidencias → matrícula/OCR → documentación → finalizar. La cámara embebida es el mecanismo vigente, con soporte vertical/horizontal y torch cuando el dispositivo lo permite. Finaliza en `in_transit` + `pickup`.

### Aparcar

Matrícula/OCR → GPS o descripción manual cuando corresponda → confirmar. `normalized_plate` lo genera DB. Finaliza en `parked` + `park`.

### Reubicar

Opera sobre un vehículo existente, protege el contexto frente a cambios concurrentes y actualiza ubicación GPS o referencia manual según disponibilidad.

### Buscar

Solo un vehículo `parked` es navegable. Si no existen coordenadas reales se muestra la descripción manual. Registra `lookup` sin cambiar estado.

### Entrega

Parte de `parked`, permite navegación solo con coordenadas reales, usa cámara embebida y OCR `parking_exit`, y finaliza en `retrieved` + `retrieve`.

## Evidencias, OCR y Expediente 360º

- Evidencias vigentes: `vehicle_evidence` en Storage privado.
- OCR activo en `airport_pickup`, `parking` y `parking_exit`.
- Overrides quedan auditados en `plate_verifications`.
- Expediente 360º admite ubicación GPS/manual, evidencias, OCR e historial.
- PDF selectivo conserva siempre el resumen esencial y permite seleccionar secciones/fotografías.
- Límite vigente de selección PDF: 15 MB / 60 fotos.
- Las URLs de consulta/compartición son temporales.

## Equipo en vivo

- Fuente: Telegram Live Location.
- Una fila vigente por usuario.
- No se conserva trayectoria histórica.
- Dejar de compartir elimina/expira la posición visible.
- `worker_daily_presence` conserva presencia diaria para informes.

## Reservas y asignación

- Gestión de reservas protegida por permisos backend.
- Importación Excel, CRUD, búsqueda, control de versión e idempotencia forman parte del flujo vigente.
- Asignación manual notifica al operario.
- `SIN ASIGNAR` retira responsable manteniendo historial y aviso cuando corresponda.
- Confirmar un plan del Asistente IA aplica asignaciones y genera notificaciones de asignación/reasignación con paridad respecto al flujo manual.
- Las asignaciones manuales fijadas son restricciones del optimizador.

## Optimizer V2

- Fase 1 estable: Fast y Optimal sobre rolling horizon continuo 24/7.
- Participantes y horizonte quedan protegidos durante un job activo.
- Ningún plan con errores de validación física puede aceptarse.
- Fase 2 permanece experimental y fuera del camino estable.

## Retención y Factory Reset

El entorno desplegado actual sigue siendo de pruebas sin usuarios reales. La retención efectiva de evidencias entregadas está temporalmente reducida a **5 minutos** para pruebas de mantenimiento. La política prevista para explotación real es **15 días** y debe restaurarse antes de incorporar usuarios reales. Una disputa abierta protege la evidencia frente a la purga automática.

Factory Reset está implementado para Root. Elimina datos operativos conforme a su contrato, conserva la identidad/configuración técnica necesaria y restaura el estado de escritura de reservas para Owner. Debe ser seguro ante reintentos.

## Observabilidad

Root dispone de observabilidad de recursos del proyecto. PostgreSQL y Storage se miden directamente; API Requests y Edge Function Invocations se consultan desde backend mediante la Management API cuando están disponibles. Egress permanece fuera del alcance actual. El informe diario de salud se envía a Root/Admin a medianoche de Madrid según la implementación vigente.

## Conectividad y navegación

- Los errores de falta de Internet y backend no disponible se presentan de forma diferenciada y amigable.
- Los avisos respetan tema claro/oscuro y no deben duplicarse.
- La navegación interna usa el contrato vigente de Telegram WebApp/BackButton y los flujos protegidos conservan su navegación segura.
- Home muestra primero el contenido común y resuelve después las tarjetas administrativas sin reordenar visualmente el contenido ya mostrado.

## Contrato de release

`release/manifest.json` declara versión/build, Service Worker, backend, Optimizer y Edge Functions críticas. Stable Release Guard valida la coherencia del código fuente con ese contrato. Deployed Release Verification valida el contenido servido por GitHub Pages cuando aplica.

Supabase/Telegram son componentes externos; una verificación verde de Pages no debe interpretarse por sí sola como prueba del estado remoto de todos esos servicios.

## Regla de modificación

Cualquier cambio que afecte interfaz, permisos, flujo operativo, backend o comportamiento estable debe:

1. partir del `main` vigente;
2. mantener código, migraciones y manifest coherentes;
3. actualizar build/cache cuando el contrato de release lo requiera;
4. pasar las pruebas y guards aplicables;
5. desplegar únicamente la fuente versionada y verificada;
6. actualizar esta documentación solo cuando cambie el contrato estable.

Las cronologías, auditorías cerradas y baselines sustituidas pertenecen al historial Git, no a este documento.