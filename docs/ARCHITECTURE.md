# ParkingMartin-G — Arquitectura actual

Revisada contra código y migraciones de `main`: 2026-09-13.

## Fuente de verdad

El código, las migraciones y la configuración versionada en `main` son la fuente de verdad técnica. Este documento es una vista arquitectónica y debe actualizarse cuando cambien los contratos implementados.

## Vista general

```text
Telegram Bot API
      |
telegram-gateway
      |
Telegram Mini App — GitHub Pages
      |
      +-- APIs operativas
      +-- reservas / tareas / notificaciones
      +-- sesiones de acceso y de flujo
      +-- consulta / Expediente 360
      +-- Equipo en vivo
      |
Supabase
      +-- PostgreSQL
      +-- Storage privado
      +-- Edge Functions
      +-- cron / red backend
      |
      +-- Google Cloud Vision (OCR)
      +-- worker Docker / OR-Tools (Optimizer V2)
```

## Telegram

`telegram-gateway` es el punto de entrada del bot. El chat privado proporciona acceso a la Mini App, ubicación en vivo y notificaciones. La UI operativa clásica por botones está retirada del producto visible.

Los grupos no constituyen una superficie operativa válida. Los componentes heredados solo deben conservarse mientras exista una dependencia real comprobada.

## Modelo de sesión

Existen dos niveles diferentes y no deben confundirse:

### Sesión de acceso

`miniapp-access-session-api` gestiona la sesión de acceso de la Mini App. El TTL vigente es **22 horas**. La identidad y el estado/rol del usuario se siguen validando según el contrato backend.

### Sesión de flujo operativo

Recogida, Aparcar, Reubicar y Entrega utilizan sesiones protegidas `operation_flow_sessions`. El TTL vigente es **20 minutos**. El contexto recuperable se revalida contra backend antes de continuar un flujo tras reapertura/recarga.

**Buscar coche no crea `operation_flow_sessions`; es una consulta autenticada.**

## Flujos operativos

### Recogida

Captura evidencias requeridas, foto de matrícula/OCR y documentación aplicable. Al finalizar registra el evento y mantiene la trazabilidad de la estancia.

### Aparcar

Verifica matrícula, captura posición GPS cuando está disponible y exige referencia manual según la calidad/condiciones del posicionamiento. La ubicación queda asociada al vehículo bajo custodia.

### Reubicar

Actualiza de forma controlada la ubicación de un vehículo bajo custodia mediante el flujo vigente y sus mismas reglas de protección de sesión cuando aplica.

### Buscar coche

Consulta el estado y localización del vehículo aparcado. La navegación solo tiene sentido cuando existen coordenadas válidas; cuando no existen debe utilizarse la referencia manual disponible. No modifica el estado del vehículo.

### Entrega

Localiza el vehículo, realiza la verificación de salida y cierra la operación conservando la trazabilidad correspondiente.

## Cámara y OCR

Recogida, Aparcar y Entrega comparten la cámara embebida vigente en la Mini App. El flujo utiliza `getUserMedia` dentro de Telegram y dispone de la UX común validada para orientación/controles. Google Cloud Vision participa en la verificación OCR de matrícula donde corresponde.

## Reservas

La gestión de reservas se realiza mediante las APIs modernas y PostgreSQL. La escritura administrativa utiliza el estado global `parking_booking_write_state`; Factory Reset reconstruye este singleton con el Owner preservado para evitar dejar Gestión de reservas sin un estado de permiso válido.

La importación analiza el archivo seleccionado y la visualización debe representar el contenido de la importación actual independientemente de que un archivo equivalente se hubiera procesado anteriormente; la deduplicación de persistencia no debe convertirse en una UI vacía.

## Tareas y asignaciones

Las reservas generan tareas operativas según el estado real del vehículo. Las tareas pueden asignarse/reasignarse a usuarios activos o quedar `SIN ASIGNAR`.

La asignación manual crea notificaciones persistentes y entrega Telegram mediante la infraestructura de notificaciones. La confirmación de planes IA dispone de paridad de notificaciones implementada en base de datos; queda pendiente únicamente su comprobación física end-to-end en el entorno desplegado.

## Optimizer V2

La optimización es asíncrona:

```text
Mini App
   -> API de jobs
   -> optimization_jobs
   -> worker Docker Python/OR-Tools
   -> validación física
   -> plan/propuesta
   -> reconciliación / notificación
```

Fase 1 es estable y usa rolling horizon continuo 24/7 con modos Fast/Optimal. Fase 2 permanece experimental y separada.

## Equipo en vivo

Se conserva únicamente la última ubicación necesaria para la vista en vivo; no se almacena trayectoria. La arquitectura es dirigida por eventos/Realtime y no utiliza polling periódico del backend. Al finalizar la compartición, la posición debe desaparecer conforme al contrato vigente.

## Evidencias y Expediente 360

Las evidencias se almacenan en Storage privado y metadatos PostgreSQL. Expediente 360 consulta la estancia, historial, verificaciones y evidencias autorizadas. Las referencias a evidencias privadas se sirven mediante mecanismos temporales/autorizados.

Una disputa abierta suspende la purga ordinaria de la evidencia afectada.

## Retención

El entorno desplegado actual es de pruebas y no tiene usuarios reales. `evidence_retention_minutes=5` mantiene actualmente una ventana efectiva de **5 minutos** para acelerar las pruebas. La política prevista para explotación real es **15 días**.

Antes de incorporar usuarios reales debe retirarse/desactivarse el override corto y verificarse que el plazo efectivo sea 15 días. La selección de candidatos, purga sin disputa y protección por disputa ya fueron validadas.

## Factory Reset

Factory Reset es Owner-only y está separado del mantenimiento ordinario. Incluye preview, confirmación, control de ejecución, limpieza de Storage operativo, limpieza lógica transaccional, reinicio de configuración física, preservación del Owner y reconstrucción del escritor de reservas.

No se utiliza el tamaño físico de PostgreSQL como criterio de éxito del reset.

## Salud y observabilidad

El sistema registra métricas e informes de salud/consumo. Las métricas de infraestructura (por ejemplo, solicitudes API o invocaciones de funciones) pueden sobrevivir a un Factory Reset porque no representan datos operativos del parking.

## Roles

Los valores internos son `owner`, `admin` y `operario`. `owner` se presenta como **Root**. Las autorizaciones sensibles se comprueban en backend y no deben depender de etiquetas o estados enviados por el cliente.

## UX de errores y conectividad

La UI debe traducir errores técnicos a mensajes accionables. HTTP, SQL/PostgREST, stack traces y códigos internos se reservan para diagnóstico.

La conectividad se trata como una capacidad independiente de la sesión. Cualquier cambio del detector debe partir de un caso reproducible para evitar falsos estados offline al abrir desde Telegram.

## Release

Los cambios parten de un `main` conocido, se realizan en rama y se integran mediante Pull Request. Los workflows de protección/verificación se aplican según los paths cubiertos por su configuración vigente. Los documentos históricos no determinan por sí solos qué build está desplegado.
