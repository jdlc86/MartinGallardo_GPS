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
- El modelo físico V1 parte de `PARKING` como nodo inicial operativo de cada jornada. Este supuesto queda centralizado en `ai_dispatch_config.daily_start_node` y no está hardcodeado en la interfaz.

## 7. Implementación actual en Supabase

Migraciones añadidas:

- `ai_dispatch_planning_v1`
- `ai_dispatch_session_handover_v1`
- `secure_ai_dispatch_trigger_function`
- `ai_dispatch_nodes`
- `ai_dispatch_confirmation_guard`
- `ai_dispatch_physical_model_v1`

Tablas nuevas:

- `ai_dispatch_config`
- `ai_dispatch_plans`
- `ai_dispatch_route_matrix`
- `ai_dispatch_sessions`
- `ai_dispatch_nodes`

Las tablas nuevas tienen RLS habilitado y acceso directo revocado a `anon` y `authenticated`; el acceso se realiza desde backend controlado.

La configuración física añade:

- `daily_start_node = PARKING`
- `companion_same_required_route_only = true`
- `confirmation_enabled = false`
- `engine_status = physical_model_diagnostic_v1`

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
- versión actual desplegada: **v5**

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

Las cinco franjas se refrescan de forma agrupada. Con 6 nodos son 36 elementos por llamada (30 trayectos útiles al excluir origen=destino).

La duración base se inicializa con `staticDuration` cuando está disponible. `current_duration_s` utiliza la estimación sensible al tráfico. Se calcula `deviation_pct` y, en V1, una desviación absoluta ≥25 % marca `is_anomaly=true`.

La matriz se persiste mediante clave:

`origin + destination + time_band`

### Política de refresco

- si la franja está vigente según TTL, se reutiliza;
- si está vencida, se recalcula;
- el Admin dispone de `Actualizar trayectos` para forzar el refresco;
- al optimizar se intenta refrescar automáticamente;
- si Google no está configurado o un nodo no está resuelto, el fallo de refresco no modifica asignaciones y queda registrado en la propuesta.

## 9. Modelo físico de cada operación

### `pickup` — Recogida al cliente que se va de viaje

1. El operario debe llegar a la terminal antes del objetivo temporal.
2. Se realiza la rutina operacional de `10 min`.
3. El operario conduce el coche del cliente **Terminal → Parking**.
4. El operario vuelve a quedar físicamente disponible en `PARKING` cuando termina el trayecto.

### `delivery` — Entrega al cliente que llega

1. El operario y el coche parten de `PARKING`.
2. El operario conduce el coche del cliente **Parking → Terminal**.
3. La salida se calcula para intentar llegar `5 min` antes.
4. Se realiza la rutina operacional de `10 min`.
5. El operario queda físicamente disponible en la terminal.

Por tanto, Parking↔terminal no es una arista libre para un trabajador. No existe coche de empresa.

## 10. Modelo físico diagnóstico V5

El motor desplegado se identifica como:

`physical_diagnostic_v1`

No es todavía OR-Tools/CP-SAT y permanece sin capacidad de confirmar asignaciones.

### 10.1 Recursos de transporte creados por las propias tareas

Cada tarea produce un trayecto obligatorio del coche del cliente:

- `delivery` → recurso `PARKING → TERMINAL`;
- `pickup` → recurso `TERMINAL → PARKING`.

Cada uno de esos trayectos dispone como máximo de **un asiento logístico adicional** para un compañero.

### 10.2 Regla de no desvío del vehículo del cliente

V1 aplica:

`companion_same_required_route_only = true`

Un coche de cliente no se desvía para resolver logística interna. El compañero puede aprovechar el recorrido que el coche ya debe hacer por el servicio, pero no se introduce una parada o ruta adicional para recogerlo/dejarlo.

Esto reduce exposición reputacional y evita kilómetros adicionales artificiales.

### 10.3 Encadenamientos físicos

El motor distingue, entre tareas consecutivas de un mismo operario:

- `pickup → delivery`: termina en Parking y puede iniciar una delivery posterior desde Parking si existe tiempo suficiente;
- `delivery → pickup`: termina en una terminal y puede desplazarse por Bus Tránsito/tren a la terminal del pickup si cabe en la ventana;
- `pickup → pickup`: después del primer pickup vuelve a Parking; para el segundo pickup necesita volver al aeropuerto aprovechando un asiento compatible en una delivery de otro operario;
- `delivery → delivery`: tras la primera delivery queda en aeropuerto; necesita regresar a Parking aprovechando un asiento compatible en un pickup de otro operario antes de conducir la segunda delivery.

Además, si la primera tarea diaria es un `pickup`, el operario necesita un transporte `Parking → aeropuerto` antes de esa tarea.

### 10.4 Emparejamiento de compañeros

El motor V5 construye dos conjuntos:

- `seats`: asientos disponibles creados por movimientos obligatorios de vehículos de cliente;
- `needs`: necesidades de desplazamiento Parking↔aeropuerto de otros operarios.

Una necesidad solo puede emparejarse si:

- dirección compatible;
- conductor y pasajero son personas diferentes;
- asiento aún libre;
- máximo un compañero por coche;
- tiempos compatibles;
- si las terminales difieren, el pasajero puede completar el desplazamiento mediante lanzadera/tren dentro de la ventana temporal.

El emparejamiento no modifica la ruta del vehículo cliente.

### 10.5 Lanzadera como prioridad entre terminales

Entre terminales se usa el modelo de Bus Tránsito/tren, no un coche de cliente, salvo que el propio coche ya deba hacer exactamente el trayecto Parking↔terminal correspondiente a su servicio.

El informe refleja explícitamente:

- con qué compañero se viaja;
- vehículo asociado;
- hora de salida;
- terminal en la que se deja/recoge;
- desplazamiento posterior por terminales cuando sea necesario.

### 10.6 Diagnóstico de factibilidad

Toda propuesta devuelve:

- `physical_feasible`
- `unmatched_needs`
- `unassigned`

`physical_feasible=true` exige que no queden tareas sin secuencia física ni necesidades de transporte Parking↔aeropuerto sin resolver.

La Mini App muestra estos indicadores antes de los informes individuales.

## 11. T4S

T4S permanece tratada de forma especial.

El tren T4↔T4S sirve para movimiento de personas, pero una operación de coche de cliente no debe suponerse automáticamente realizable físicamente en T4S. En el motor V5, una tarea cuyo punto de operación del vehículo sea `T4S` queda marcada como:

`t4s_customer_operation_requires_mapping`

hasta disponer de una regla explícita que determine cuál es el punto terrestre real de entrega/recogida del vehículo asociado a un cliente de T4S.

No se inventa una ruta de coche hacia T4S.

## 12. Guardia de confirmación

`ai_dispatch_config` mantiene:

- `confirmation_enabled = false`
- `engine_status = physical_model_diagnostic_v1`

Consecuencias:

- el Asistente puede generar propuestas de diagnóstico;
- ninguna propuesta puede materializar asignaciones automáticamente;
- la protección existe en backend y Mini App;
- incluso una propuesta con `physical_feasible=true` continúa sin poder confirmarse mientras la guarda esté desactivada.

La confirmación solo se habilitará después de validar el motor físico y los datos de trayecto.

## 13. API del planificador

Acciones actuales:

- `status`
- `refresh_routes`
- `optimize`
- `confirm` — bloqueada y devuelve `ai_planner_confirmation_disabled`
- `reject`

`status` devuelve permiso/epoch, horizonte, disponibilidad Google, nodos resueltos, `confirmation_enabled` y `engine_status`.

`optimize` devuelve además los diagnósticos físicos y los informes completos.

Cuando se habilite la confirmación, esta volverá a reutilizar `reservation-task-api` para conservar historial, versiones y notificaciones; no se creará un mecanismo de asignación paralelo.

## 14. Mini App

`docs/preview-modern/ai-dispatch.html` muestra actualmente:

- estado de permiso;
- solicitud del mismo permiso de Lectura/Escritura de Gestión de Reservas;
- Google Routes configurado/pendiente;
- nodos resueltos;
- estado del motor;
- factibilidad física de la propuesta;
- número de traslados de operarios sin resolver;
- número de tareas sin secuencia física;
- incidencias principales;
- informes individuales por operario;
- botones de rechazar y recalcular.

Confirmar permanece deshabilitado mientras `confirmation_enabled=false` o si la propuesta no es físicamente factible.

## 15. Estado de pruebas con datos reales

El 2 de septiembre de 2026 se consultó en solo lectura el horizonte de los siguientes 7 días de `reservation_tasks`. En ese momento no existían tareas futuras `unassigned/assigned` dentro de ese intervalo, por lo que todavía no se dispone de un caso real suficiente para validar el emparejamiento físico V5 contra producción.

No se crearon reservas ni asignaciones ficticias en producción para forzar la prueba.

## 16. Pendientes antes de habilitar confirmación

1. Ejecutar `Actualizar trayectos` desde una sesión Telegram autorizada y verificar resolución de los seis nodos y Routes API.
2. Reemplazar cualquier tiempo de lanzadera todavía estimado por una matriz explícita/validada antes de producción.
3. Definir el mapeo operativo de reservas de clientes T4S al punto terrestre real de vehículo.
4. Probar `physical_diagnostic_v1` con un conjunto representativo de reservas y varias combinaciones de operarios.
5. Incorporar el margen de retraso `pickup +5 / delivery +10` como alternativa penalizada; el diagnóstico V5 trabaja de forma conservadora sobre el objetivo de 5 min antes.
6. Validar las asignaciones manuales físicamente sin modificarlas: si una manual crea una imposibilidad debe señalarse, nunca reasignarse automáticamente.
7. Evolucionar el motor a OR-Tools/CP-SAT o servicio equivalente manteniendo el contrato `optimize → proposal → confirm`.
8. Solo entonces habilitar `confirmation_enabled` y hacer pruebas controladas de confirmación.
9. Añadir posteriormente la capa conversacional IA para instrucciones de reoptimización con revalidación de `writer_epoch` en cada mensaje.

Estos pendientes no alteran el modelo de permisos ni la regla de que las asignaciones manuales son inmutables.