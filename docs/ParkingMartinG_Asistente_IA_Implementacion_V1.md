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

## 8. Google Routes — integración V3

Edge Function:

- `reservation-ai-planner`
- versión actual desplegada: **v3**

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

## 9. API del planificador

Acciones actuales:

- `status`
- `refresh_routes`
- `optimize`
- `confirm`
- `reject`

`status` devuelve también si Google Routes está configurado y qué nodos están resueltos.

La confirmación **no escribe mediante una ruta paralela**: reutiliza `reservation-task-api` para materializar las asignaciones y conservar historial, control de versión y notificaciones existentes.

Tras confirmar, además se crean los informes `ai_plan_report` para cada operario y copias `ai_plan_report_admin` para el Admin. Después se dispara el mecanismo existente de entrega Telegram.

## 10. Mini App

Archivo:

- `docs/preview-modern/ai-dispatch.html`

`task-dispatch-runtime.js` inserta el botón `✨ IA` en Asignación de tareas sin sustituir el flujo manual.

La pantalla IA permite:

- comprobar el permiso actual;
- solicitar Lectura/Escritura usando el mecanismo existente;
- visualizar estado de Google Routes;
- visualizar cuántos nodos geográficos están resueltos;
- forzar `Actualizar trayectos`;
- elegir horizonte;
- generar propuesta;
- revisar todos los informes por operario;
- confirmar de una vez;
- rechazar;
- solicitar una nueva optimización.

## 11. Estado del motor V1

El backend actual usa `deterministic_v1_routes`. Ya incorpora la matriz de carretera cuando está disponible, la incertidumbre inicial y la inmutabilidad de tareas manuales.

**Aún no debe describirse como OR-Tools/CP-SAT.** La capa de contrato (`optimize → proposal → confirm`) se ha diseñado para permitir sustituir el motor sin cambiar permisos, UI ni workflow de confirmación.

## 12. Pendientes técnicos explícitos

Antes de considerar cerrada la optimización logística avanzada faltan:

1. Verificar en ejecución que los seis enlaces cortos de Maps se resuelven correctamente desde Supabase; cualquier nodo no resoluble se configurará con coordenadas/Place ID verificado, no aproximado.
2. Confirmar que la clave Google existente tiene **Routes API habilitada**. Si devuelve `google_routes_not_enabled`, habilitar Routes API o proporcionar una clave específica.
3. Incorporar al motor la optimización explícita de recogida/traslado de un compañero (máximo uno), incluyendo sincronización de los dos itinerarios y límite de km del vehículo de cliente.
4. Evolucionar el motor determinista a OR-Tools/CP-SAT o servicio equivalente manteniendo el mismo contrato.
5. Añadir la capa conversacional IA para instrucciones de reoptimización, siempre revalidando `writer_epoch` en cada mensaje.

Estos pendientes no modifican el modelo de permisos, confirmación ni conservación de asignaciones manuales ya implementados.