# ParkingMartin-G
## Asistente IA de asignación — Implementación V1

**Continuación técnica de:**
- `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`
- `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios_CONTINUACION.md`

Este documento fija los parámetros cerrados para V1 y registra la implementación iniciada el 2 de septiembre de 2026.

## 1. Parámetros cerrados de incertidumbre

V1 utiliza márgenes deterministas configurables; no se introduce todavía un modelo probabilístico complejo.

- Carretera: `10 %` sobre la duración estimada, con mínimo de `2 min`.
- Coordinación con compañero: `3 min` adicionales cuando exista una dependencia de recogida/traslado.
- Bus Tránsito T1/T2/T3/T4: `5 min` de acceso + espera conservadora máxima según frecuencia + tiempo de trayecto.
  - 06:00–22:00: espera máxima `5 min`.
  - 22:00–06:00: espera máxima `20 min`.
- T4↔T4S: `10 min` de acceso + tiempo de tren + espera variable/conservadora según frecuencia.
- Tiempo operativo por `pickup`/`delivery`: `10 min`.
- Objetivo de llegada: `5 min` antes.
- Retraso máximo: `pickup +5 min`; `delivery +10 min`.

Todos estos valores se almacenan en `ai_dispatch_config` y no deben dispersarse como constantes de negocio por el frontend.

## 2. TTL de Google Routes

- Trayectos necesarios dentro de las siguientes 24 h: TTL `2 h`.
- Trayectos de días posteriores dentro del horizonte: TTL `12 h`.
- Sin polling fijo.
- Antes de optimizar, el backend reutiliza caché vigente y refresca solo datos caducados/necesarios.
- Google se usa como sensor de calibración por `origen × destino × franja`, no por reserva individual.

## 3. Formato de informe Telegram

Cada operario recibe texto cronológico y accionable. Debe contener fecha/hora, tipo de operación, terminal, matrícula, cliente, hora de salida recomendada, medio de desplazamiento y dependencias.

Ejemplo conceptual:

```text
📅 Plan operativo · Miércoles 3
07:35 · Salir del Parking
08:00 · RECOGIDA · T4 · 1234ABC · Juan Pérez
08:10 · Fin operación
08:15 · Lanzadera T4 → T1
08:30 · Llegada prevista T1
08:45 · ENTREGA · T1 · 5678DEF · Ana Ruiz

👥 Recoger compañero: Pedro en T1 a las 09:00 → Parking
⚠️ Mantener el itinerario indicado para cumplir las siguientes operaciones.
```

Si no existe traslado de compañero, esa sección no aparece. El Admin recibe todos los informes individuales.

## 4. Permisos y cambio de titular

Se reutiliza exclusivamente el mecanismo existente de Gestión de Reservas:

- `parking_booking_write_state`
- `writer_epoch`
- `parking_booking_request_write`
- `parking_booking_offer_transfer`
- `parking_booking_respond_permission`
- `parking_booking_require_writer`

Mensaje cuando el usuario no tiene escritura:

> **No tienes permisos para usar el Asistente IA de asignación. Solicita acceso de lectura/escritura.**

La solicitud usa el mismo workflow actual; no existe un sistema de permisos paralelo.

Si cambia el titular de Lectura/Escritura durante una sesión IA activa, las propuestas pendientes del anterior titular se invalidan y la sesión debe reiniciarse. Se generan avisos de cierre para el anterior titular y disponibilidad para el nuevo titular cuando corresponde.

## 5. Asignaciones manuales

Las asignaciones manuales son **inmutables para el solver**.

- El Admin puede fijarlas antes de lanzar la IA.
- El solver nunca propone cambiarlas.
- Una reoptimización tampoco las toca.
- Ocupan tiempo/posición en el itinerario y condicionan la solución restante.
- En la confirmación se comprueba que siguen intactas; si cambiaron, el plan se invalida.

## 6. Horizonte

- Predeterminado: `7 días`.
- Configurable entre 1 y 31 días en V1.

## 7. Implementación actual en Supabase

Migraciones añadidas:

- `ai_dispatch_planning_v1`
- `ai_dispatch_session_handover_v1`
- `secure_ai_dispatch_trigger_function`
- `ai_dispatch_nodes`
- `ai_dispatch_confirmation_guard`

Tablas nuevas:

- `ai_dispatch_config`
- `ai_dispatch_plans`
- `ai_dispatch_route_matrix`
- `ai_dispatch_sessions`
- `ai_dispatch_nodes`

Las tablas nuevas tienen RLS habilitado y acceso directo revocado a `anon` y `authenticated`; el acceso se realiza desde backend controlado.

### Nodos geográficos

`ai_dispatch_nodes` contiene los seis enlaces aportados por el negocio:

- PARKING
- T1
- T2
- T3
- T4
- T4S

El backend intenta resolver los enlaces cortos de Google Maps y persiste `resolved_url` y coordenadas cuando puede extraerlas de forma fiable. **No se inventan coordenadas**. Si algún nodo no queda resuelto, la matriz Google se considera incompleta y se informa de ello.

## 8. Google Routes — integración actual

Edge Function:

- `reservation-ai-planner`
- versión actual desplegada: **v4**

La función busca una clave en este orden:

1. `GOOGLE_MAPS_API_KEY`
2. `GOOGLE_ROUTES_API_KEY`
3. `GOOGLE_API_KEY`

La clave no se expone al frontend.

Se utiliza `ComputeRouteMatrix` de Google Routes con:

- `travelMode = DRIVE`
- `routingPreference = TRAFFIC_AWARE`
- `departureTime` futuro representativo de cada franja
- `distanceMeters`
- `duration`
- `staticDuration`

Las cinco franjas se refrescan de forma agrupada. Con 6 nodos son 36 elementos por llamada (30 trayectos útiles al excluir origen=destino), dentro de los límites del servicio.

La duración base se inicializa con `staticDuration` cuando está disponible. `current_duration_s` utiliza la estimación sensible al tráfico. Se calcula `deviation_pct` y, en V1, una desviación absoluta ≥25 % marca `is_anomaly=true`.

La matriz se persiste mediante clave:

`origin + destination + time_band`

### Política de refresco

- si la franja está vigente según TTL, se reutiliza;
- si está vencida, se recalcula;
- el Admin dispone además de `Actualizar trayectos` para forzar el refresco;
- al optimizar se intenta refrescar automáticamente;
- si Google no está configurado o un nodo no está resuelto, el fallo de refresco no modifica asignaciones y queda registrado en la propuesta.

## 9. Corrección crítica del modelo logístico

Durante la revisión de la primera integración se detectó una simplificación incorrecta que **no debe llegar a producción**:

Una tarea de aeropuerto no puede modelarse como si el operario terminara siempre en la propia terminal.

El modelo correcto es:

### `pickup` — Recogida al cliente que se va de viaje

1. El operario debe estar en la terminal antes de la hora objetivo.
2. Se ejecutan los `10 min` operativos.
3. El operario conduce el coche del cliente **Terminal → Parking**.
4. El operario vuelve a quedar disponible físicamente en `PARKING` una vez terminado ese trayecto.

### `delivery` — Entrega al cliente que llega

1. El coche y el operario parten de `PARKING`.
2. El operario conduce el coche del cliente **Parking → Terminal** con salida calculada para cumplir la hora objetivo.
3. Se ejecutan los `10 min` operativos de entrega.
4. El operario queda físicamente disponible en la terminal correspondiente.

Esto implica que **Parking↔terminal no es un traslado libre del operario**. No existe coche de empresa. Un operario solo puede cubrir ese movimiento mediante:

- el propio coche de cliente asociado a una operación que conduce;
- viajar como máximo como **un compañero** en otro coche de cliente compatible con la ruta y el límite de km;
- para movimientos entre terminales, utilizar el Bus Tránsito/tren cuando corresponda.

Por tanto, la logística de compañeros no es únicamente una mejora de eficiencia: es parte estructural de la factibilidad de determinados encadenamientos.

## 10. Guardia de confirmación

Hasta que el nuevo modelo de posición física y transporte Parking↔terminal esté implementado, `ai_dispatch_config` mantiene:

- `confirmation_enabled = false`
- `engine_status = logistics_model_in_progress`

Consecuencias:

- el Asistente puede generar propuestas de diagnóstico;
- puede probar permisos, horizonte, refresco Google, inmutabilidad manual e interfaz;
- **no puede aplicar las asignaciones a producción**;
- la protección existe tanto en backend como en la Mini App.

`reservation-ai-planner` devuelve `ai_planner_confirmation_disabled` si alguien intenta confirmar por API mientras la guarda está activa.

La confirmación solo se habilitará cuando el motor represente correctamente el estado físico del operario y las dependencias de transporte.

## 11. API del planificador

Acciones actuales:

- `status`
- `refresh_routes`
- `optimize`
- `confirm` — protegida por `confirmation_enabled`
- `reject`

`status` devuelve:

- permiso/epoch;
- horizonte por defecto;
- disponibilidad de Google Routes;
- nodos geográficos resueltos;
- `confirmation_enabled`;
- `engine_status`.

Cuando se habilite la confirmación, esta reutilizará `reservation-task-api` para conservar historial, versiones y notificaciones. También generará los informes `ai_plan_report` para cada operario y copias `ai_plan_report_admin` para el Admin.

## 12. Mini App

Archivo:

- `docs/preview-modern/ai-dispatch.html`

`task-dispatch-runtime.js` inserta el botón `✨ IA` en Asignación de tareas sin sustituir el flujo manual.

La pantalla IA permite actualmente:

- comprobar el permiso actual;
- solicitar Lectura/Escritura usando el mecanismo existente;
- visualizar estado de Google Routes;
- visualizar cuántos nodos geográficos están resueltos;
- visualizar si la confirmación está habilitada;
- forzar `Actualizar trayectos`;
- elegir horizonte;
- generar propuesta de diagnóstico;
- revisar informes;
- rechazar o recalcular.

Mientras `confirmation_enabled=false`, el botón de confirmar permanece deshabilitado.

## 13. Estado del motor

El backend actual sigue identificándose como `deterministic_v1_routes` y **no debe describirse como motor final** ni como OR-Tools/CP-SAT.

La capa contractual (`optimize → proposal → confirm`) se mantiene estable para que el motor pueda evolucionar sin rediseñar permisos, UI ni workflow de confirmación.

El siguiente motor debe representar al menos:

- posición física del operario en el tiempo;
- fases internas de pickup/delivery;
- trayectos de vehículo cliente;
- lanzadera/tren entre terminales;
- emparejamiento conductor/compañero con capacidad máxima 1;
- restricción de km adicionales;
- asignaciones manuales fijadas;
- incertidumbre y ventanas de puntualidad;
- balance de carga como objetivo secundario.

## 14. Pendientes técnicos explícitos

1. Ejecutar desde la Mini App `Actualizar trayectos` para verificar que Supabase puede resolver los seis enlaces de Maps y que la clave disponible tiene Routes API habilitada.
2. Si algún enlace no es resoluble, registrar coordenadas/Place ID verificados, nunca aproximados.
3. Implementar el nuevo motor logístico con estados físicos Parking/terminal y sincronización de compañeros.
4. Una vez verificado, habilitar `confirmation_enabled` y realizar pruebas controladas antes de producción.
5. Evolucionar a OR-Tools/CP-SAT o servicio equivalente manteniendo el contrato actual.
6. Añadir la capa conversacional IA para instrucciones de reoptimización, revalidando `writer_epoch` en cada mensaje.

Estos pendientes no alteran el modelo de permisos ni la regla de que las asignaciones manuales son inmutables.