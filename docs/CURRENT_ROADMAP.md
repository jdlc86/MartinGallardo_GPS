# ParkingMartin-G — Roadmap técnico vigente

Revisado contra `main`: 2026-09-13.

## Fuente de verdad

El código, las migraciones y la configuración versionada en `main` son la fuente de verdad técnica. Los documentos fechados describen contexto histórico y no prevalecen sobre el código actual.

## Implementado y no pendiente

La aplicación dispone actualmente de los cuatro flujos modernos, Gestión de reservas, importación, asignación manual, estado `SIN ASIGNAR`, confirmación IA con paridad de notificaciones, Optimizer V2 Fase 1, Equipo en vivo por Realtime, Factory Reset Owner-only, mantenimiento y retención con protección por disputa, y observabilidad de base de datos.

La sesión de acceso tiene TTL de **22 horas**. Los flujos protegidos usan `operation_flow_sessions` con TTL de **20 minutos**. Buscar coche es una consulta autenticada y no crea sesión de flujo.

## Pendiente inmediato

1. Mantener toda la documentación vigente sincronizada con `main` y separar claramente los documentos históricos.
2. Validar físicamente end-to-end la notificación Telegram al conductor después de confirmar una asignación IA; la lógica ya existe y no debe duplicarse.
3. Continuar la regresión reproducible del aviso de conectividad desde Telegram antes de modificar esa lógica.
4. Comprobar varios ciclos reales de los informes programados y ausencia de duplicados.
5. Ampliar pruebas automáticas de roles, sesiones, flujos, reservas, asignaciones, Factory Reset, retención, Equipo en vivo e informes.

## Retención durante pruebas

El entorno desplegado actual es de pruebas y no tiene usuarios reales. La retención efectiva de evidencias se mantiene intencionadamente en **5 minutos** para acelerar las pruebas. La política prevista para explotación real es **15 días**.

Antes de incorporar usuarios reales es obligatorio retirar el override de 5 minutos y verificar que el plazo efectivo sea 15 días. La purga sin disputa y la protección por disputa abierta ya están validadas.

## Backend heredado

La interfaz operativa clásica por botones está retirada. Cualquier retirada adicional de componentes heredados requiere primero inventariar dependencias reales y comprobar que no se rompe compatibilidad necesaria de acceso.

## Robustez

Antes de añadir deduplicación, índices, caches o refactors transversales debe auditarse lo que ya existe. No se debe duplicar lógica implementada. Las optimizaciones deben partir de métricas y planes de consulta reales.

## UX

La UI debe presentar mensajes accionables y evitar detalles técnicos. Queda revisar la cobertura real de la capa común de errores y corregir solo las pantallas que todavía no cumplan el contrato vigente.

## Optimizer V2

Fase 1 permanece estable: rolling horizon 24/7, Fast/Optimal, worker Docker, cola durable, reconciliación y validación física independiente.

Fase 2 permanece experimental y separada. Solo podrá considerarse estable con benchmark reproducible, cobertura no decreciente y cero errores físicos.

## Fuera de alcance salvo decisión explícita

- app móvil nativa;
- multi-parking;
- trayectoria histórica de operarios;
- reintroducir operaciones por botones en el chat;
- navegación para vehículos no aparcados.

La existencia de tablas legacy no basta para declarar una funcionalidad operativa.
