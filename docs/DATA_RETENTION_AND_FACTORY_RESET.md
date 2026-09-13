# ParkingMartin-G — Política de retención y Factory Reset

Fecha de diseño: 2026-09-10  
Última auditoría: 2026-09-13

## Fuente de verdad

El código, las migraciones y la configuración versionada en `main` son la fuente de verdad técnica. Este documento describe ese estado y no sustituye al comportamiento implementado.

## Objetivo

Separar de forma segura el mantenimiento ordinario, la retención de evidencias y el Factory Reset Owner-only.

## Estado auditado 2026-09-13

Factory Reset está implementado y probado. Dispone de preview, confirmación fuerte, control de ejecución, limpieza de Storage y finalización transaccional. Las correcciones posteriores garantizan el borrado seguro y la reconstrucción de `parking_booking_write_state` con el Owner preservado.

La prueba dejó a cero las principales tablas operativas y eliminó las evidencias físicas. `parking_config` queda no configurado y `parking_sectors` se vacía porque representa configuración física del recinto. La configuración técnica, mantenimiento, salud y retención se conserva.

## Retención efectiva actual

El entorno desplegado actual se utiliza como **entorno de pruebas y no tiene usuarios reales**.

- `evidence_retention_days`: política prevista para explotación real = **15 días**.
- `history_retention_days`: **365 días**.
- `evidence_retention_minutes`: actualmente **5 minutos efectivos**, mantenidos intencionadamente para acelerar las pruebas.

Los 5 minutos no constituyen una política adicional de datos provisionales: sustituyen temporalmente al plazo de 15 días mientras continúa la validación del entorno de pruebas.

**Antes de incorporar cualquier usuario real es obligatorio retirar/desactivar el override de 5 minutos y verificar que la retención efectiva de evidencias sea 15 días.**

## Validación funcional de retención

Ya se comprobaron los dos casos esenciales:

1. vehículo entregado sin disputa abierta: al vencer los 5 minutos entró como candidato y el mantenimiento programado eliminó la evidencia;
2. vehículo entregado con disputa abierta: al vencer la misma ventana quedó protegido y no entró como candidato.

Por tanto, la selección ordinaria de candidatos, la purga programada y la protección por disputa están funcionalmente validadas. No deben figurar como desarrollo pendiente.

## Disputas

Una disputa abierta bloquea la purga de evidencias y la eliminación del histórico. La disputa no reinicia los plazos; al cerrarla se vuelve a evaluar la fecha original aplicable.

## Ciclo de vida objetivo para explotación real

1. vehículo entregado;
2. durante 15 días: expediente completo y evidencias disponibles;
3. sin disputa: eliminación de evidencias físicas y metadatos dependientes que ya no sean necesarios;
4. conservación de histórico ligero;
5. al vencer 365 días, y sin disputa, eliminación del histórico operativo según la política implementada.

## Factory Reset Owner-only

Flujo vigente:

1. preview/dry-run;
2. autenticación Owner y confirmación fuerte;
3. control global de ejecución;
4. limpieza de Storage operativo;
5. limpieza lógica transaccional;
6. reinicio de configuración física;
7. preservación del Owner;
8. reconstrucción del estado de escritura de reservas para el Owner;
9. registro del resultado en `factory_reset_runs`.

El Factory Reset elimina datos de negocio reutilizables pero conserva la infraestructura y configuración técnica necesarias para que la instalación siga administrable.

## Alcance de datos

Se conserva la configuración técnica de evidencias, IA, salud, recursos, retención y mantenimiento, además de infraestructura, funciones, cron y contenido técnico. Se reinicia la configuración física específica del recinto.

Se eliminan datos operativos de vehículos, estancias, eventos, evidencias, verificaciones, sesiones de flujo, reservas, tareas, importaciones, planes/jobs operativos, presencia y localización. El Owner se conserva y el estado de escritura de reservas se vuelve a enlazar a él.

## Evidencia de validación del Factory Reset

Tras la prueba corregida quedaron a cero vehículos, estancias, evidencias, fotos, eventos, reservas, tareas, sesiones operativas, jobs del optimizador y sectores. Permaneció exactamente un Owner y `parking_booking_write_state` quedó válido. El único objeto de Storage observado era técnico (`miniapps/location/index.html`), no evidencia de vehículos.

El tamaño físico de PostgreSQL no es criterio de éxito del reset: los borrados dejan páginas reutilizables y el mantenimiento normal de PostgreSQL gestiona esas páginas/versiones.

## Principios

- `main` y el código/migraciones vigentes son la fuente de verdad.
- mantenimiento ordinario y Factory Reset permanecen separados;
- una disputa abierta prevalece frente a la fecha ordinaria de retención;
- el Owner debe permanecer administrable después del reset;
- cambios de base de datos se versionan antes de aplicarse al entorno desplegado;
- los controles de release se respetan cuando los paths modificados entren en su ámbito.
