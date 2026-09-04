# AGENTS.md — Reglas de mantenimiento

Este archivo define cómo modificar **ParkingMartin-G** sin reintroducir comportamiento antiguo ni romper producción.

## Prioridades

1. seguridad y permisos;
2. integridad de datos;
3. Mini App como única interfaz operativa;
4. trazabilidad;
5. idempotencia y pruebas;
6. simplicidad operativa.

## Fuente de verdad de interfaz

La interfaz operativa es `docs/preview-modern/`.

El bot privado solo debe:

- dar bienvenida/orientación;
- abrir ParkingMartin-G;
- recibir ubicación en vivo;
- entregar informes automáticos;
- gestionar el acceso inicial mediante el backend todavía necesario.

**No reintroducir menús operativos Recogida/Aparcar/Buscar/Entrega en el chat.**

`telegram-gateway` es el único webhook de producción.

## Grupos Telegram

ParkingMartin-G está diseñado para chat privado.

En `group`/`supergroup`:

- no ejecutar operaciones;
- no registrar ubicación;
- no crear sesiones;
- no gestionar usuarios;
- no reenviar a lógica operativa legacy.

Los callbacks históricos pueden recibir únicamente un aviso neutro.

## Roles

Valores internos de `telegram_users.role`:

- `owner`;
- `admin`;
- `operario`.

Reglas:

- **mostrar `owner` como `Root` en la UI**;
- solo puede existir un `owner` interno;
- Root siempre activo y protegido;
- Admin no puede modificar Root;
- Admin no cambia sus propios permisos desde panel;
- Operario no puede ver ni ejecutar Equipo & Accesos.

El backend debe comprobar permisos incluso si la UI oculta una tarjeta.

## Flujos vigentes

### Recogida

Matrícula -> fotos de estado -> foto matrícula/OCR -> documentación -> finalizar.

- requisitos dinámicos desde `evidence_requirements`;
- permitir borrar individualmente fotos de estado/documentación pendientes;
- override OCR auditado;
- finalizar -> `in_transit` + `pickup`.

### Aparcar

Matrícula -> foto matrícula/OCR -> GPS Pro -> confirmar.

- `normalized_plate` es generada por DB: **no escribirla manualmente**;
- override auditado en `plate_verifications`;
- precisión mala exige referencia textual;
- finalizar -> `parked` + `park`.

### Buscar

- solo `parked`;
- navegación solo si sigue `parked` y hay coordenadas;
- registra `lookup`;
- no cambia estado.

### Entrega

Vehículo `parked` -> Foto Matrícula/OCR de salida -> confirmar entrega.

- stage OCR: `parking_exit`;
- estado no cambia antes de confirmación;
- finalizar -> `retrieved` + `retrieve`.

## OCR

OCR está activo en:

- `airport_pickup`;
- `parking`;
- `parking_exit`.

No volver a documentar “OCR solo al aparcar”.

Resultados/overrides en `plate_verifications`. No crear operaciones arbitrarias de OCR en `parking_events`.

## Evidencias

Tabla vigente: `vehicle_evidence`.

Storage: privado `vehicle-evidence`.

No desarrollar nuevas funciones sobre `vehicle_photos` salvo migración explícita.

Usar URLs firmadas temporales para consulta.

## GPS

### Operativo

El aparcado usa GPS integrado en `park.html` y guarda lat/lng/accuracy/referencia.

### Diagnóstico

`gps-diagnostic.html` es solo informativo y no persiste nada.

**No implementar sectores ni palabra Configurar.**

## Equipo en vivo

Fuente: Telegram Live Location.

- una fila por usuario en `worker_live_locations`;
- no guardar trayectoria;
- throttling aproximado: 10 s / 5 m / mejora de precisión;
- al finalizar compartición, eliminar fila si Telegram emite la edición correspondiente;
- fallback visual máximo: 30 min;
- visible para todos los usuarios activos;
- `worker_daily_presence` guarda solo presencia diaria para informes.

## Informes

`performance-report-sender`:

- 04:00 Europe/Madrid -> día anterior;
- 13:00 -> día actual;
- 20:00 -> día actual.

Operario: individual.
Root/Admin: individual si corresponde + global de equipo.

Deduplicación: `performance_report_dispatches`.

No convertir las métricas en una puntuación subjetiva sin decisión de producto explícita.

## Solicitudes de acceso

Estados:

- `pending`;
- `approved`;
- `rejected`;
- `expired`.

Reglas:

- pending caduca 72 h;
- rejected puede volver a pending si no existe cuenta;
- bloqueado (`active=false`) no vuelve a pending;
- usuario existente debe quedar coherente con `approved`;
- no borrar auditoría para limpiar la UI.

## Optimizer V2

Reglas de mantenimiento del planificador:

- `solve()` representa exclusivamente **Fase 1 estable**;
- Fast y Optimal son dos modos del mismo Back-Forward rolling horizon 24/7;
- no introducir fronteras artificiales por día;
- no aceptar ningún plan con errores de `validate_solution()`;
- no llamar “imposible” a una tarea si la auditoría solo puede demostrar `not_proven`;
- Fase 2 de reoptimización local permanece separada y experimental;
- una reparación de Fase 2 nunca puede reducir cobertura global;
- la UI debe mostrar resultado operativo, no códigos internos de auditoría;
- Realtime es señal de actualización, no fuente de verdad: el estado durable está en `optimization_jobs`;
- el worker debe ejecutar fuera de Edge Functions y cargar secretos únicamente desde entorno servidor;
- no commitear `.env`, artefactos de benchmark ni cachés Python;
- cambios de rendimiento deben compararse sobre el mismo dataset y con el mismo límite de tiempo antes de atribuir diferencias al entorno.


## Backend heredado

`telegram-entry`, `telegram-router3`, `telegram-bot` y utilidades antiguas pueden seguir desplegadas mientras existan dependencias de acceso.

No usarlas como interfaz ni permitir que vuelvan a controlar el webhook.

Antes de eliminarlas:

1. inventariar dependencias;
2. versionar backend;
3. probar alta/rechazo/bloqueo/reactivación;
4. retirar por etapas.

## Identidad

Coexisten `telegram_users` y `workers`.

No crear una tercera identidad. Cualquier consolidación debe conservar FKs e historial.

## Idempotencia

Telegram y HTTP pueden reintentar.

Diseñar efectos de dominio idempotentes para:

- acceso;
- admin actions;
- evidencias;
- OCR/override;
- pickup/park/retrieve;
- ubicación live.

Los informes ya usan reserva/deduplicación persistente.

## Seguridad

Nunca:

- commitear secretos;
- exponer service-role al navegador;
- confiar en username como identidad;
- abrir Storage públicamente;
- permitir admin actions sin consultar DB;
- aceptar `initData` sin validación HMAC/edad;
- procesar lógica privada dentro de grupos.

### Deuda de seguridad vigente

Mantener visible hasta resolver:

- `plate_verifications` sin RLS;
- `telegram_access_requests_visible_rejected` security-definer;
- funciones históricas con search_path mutable;
- `expire_pending_access_requests()` con ejecución/security-definer a revisar.

Las funciones de informes nuevas deben mantener `EXECUTE` revocado a `anon/authenticated`.

## Esquema

Antes de DDL:

1. inspeccionar esquema real;
2. usar migraciones;
3. verificar datos/invariantes;
4. ejecutar advisors de seguridad/performance;
5. actualizar documentación.

## Pruebas mínimas por cambio

- rol/permisos;
- happy path;
- error/reintento;
- coherencia de estado;
- evidencia/Storage si aplica;
- seguridad de Mini App;
- smoke real de Telegram cuando afecte gateway/localización.

Ver `docs/TEST_PLAN.md`.

## No reintroducir

- UI operativa por botones en el bot;
- sectores de parking;
- configuración de terreno por sectores;
- botón `CERRAR`;
- nombres visibles `Owner`/`OWNER` (usar Root);
- trayectorias históricas de trabajadores;
- navegación para vehículos no `parked`;
- URLs públicas permanentes de evidencias.

## Release estable protegida

Baseline vigente: **ParkingMartin-G v1.4.0 · Build 2026.09.04.02**.

Antes de modificar comportamiento estable, leer `docs/STABLE_RELEASE.md`.

Reglas:

- no cambiar silenciosamente interfaz, permisos, contratos backend o semántica del optimizador;
- todo cambio visible o funcional debe incrementar `docs/preview-modern/release.js`;
- cambios de Mini App que puedan quedar cacheados deben invalidar el Service Worker;
- cambios de backend/worker deben actualizar su sello de versión/build cuando proceda;
- Fase 2 experimental no se fusiona en el flujo estable sin decisión explícita y pruebas de no regresión;
- si un cambio altera la baseline documentada, actualizar `docs/STABLE_RELEASE.md` en el mismo cambio.
