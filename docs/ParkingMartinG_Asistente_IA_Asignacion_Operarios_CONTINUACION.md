# ParkingMartin-G
## Asistente IA para asignación eficiente de operarios — Continuación

**Documento de continuación de:** `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`

Este documento continúa la especificación funcional y técnica del Asistente IA de planificación. Debe leerse conjuntamente con dicho documento.

> **Decisión V1 posterior y prevalente:** los candidatos automáticos son los **operarios activos**. No se utilizan niveles `BAJO/MEDIO/EXPERTO` ni `MARCA → GAMA` para decidir asignaciones automáticas en V1. Las tareas que el Admin quiera reservar se asignan manualmente antes de optimizar. **Toda asignación manual es inmutable para el solver: nunca propone cambiarla y optimiza exclusivamente alrededor de ella.**

## 18. Matriz dinámica de trayectos mediante Google Routes

### 18.1 Objetivo
Google Routes calibra periódicamente la matriz logística de carretera, no se consulta por cada reserva. Permite capturar diferencias por franja y anomalías puntuales.

`Solicitud optimización → comprobar matriz → Google Routes si procede → matriz dinámica → OR-Tools → propuesta → IA → revisión Admin → confirmación`

### 18.2 Nodos geográficos V1
Nodos iniciales de configuración:

- `PARKING`: https://maps.app.goo.gl/Rijkcdh9HzTAkfuw5?g_st=ac
- `T1`: https://maps.app.goo.gl/u6AGoB78gYFxJfrf7?g_st=ac
- `T2`: https://maps.app.goo.gl/Ebd5nGdibmH2ayZL9?g_st=ac
- `T3`: https://maps.app.goo.gl/9zA41fCfaXvginPx5?g_st=ac
- `T4`: https://maps.app.goo.gl/syAqdwBU3jFGbbkV9?g_st=ac
- `T4S`: https://maps.app.goo.gl/bMtfCW4tL95tHm8RA?g_st=ac

Antes de producción deben resolverse/verificarse las coordenadas o Place IDs concretos correspondientes a los puntos operativos reales. La matriz es dirigida.

### 18.3 Franjas horarias
| Franja | Horario Europe/Madrid |
| --- | --- |
| `MADRUGADA` | 00:00–05:59 |
| `PUNTA_MANANA` | 06:00–09:59 |
| `VALLE_DIA` | 10:00–15:59 |
| `PUNTA_TARDE` | 16:00–19:59 |
| `NOCHE` | 20:00–23:59 |

Configurables y persistentes.

### 18.4 Datos por origen/destino/franja
Campos conceptuales: `origin`, `destination`, `time_band`, `distance_m`, `baseline_duration_s`, `current_duration_s`, `deviation_pct`, `fetched_at`, `source`, `is_anomaly`.

### 18.5 Actualización/caché
Las consultas se agrupan por nodo/franja. Antes de optimizar se comprueba vigencia y se refresca solo lo necesario. Con 6 nodos hay 30 trayectos dirigidos útiles y 150 combinaciones para 5 franjas antes de caché.

### 18.6 Anomalías
Comparar dato actual con baseline. Umbral configurable. Si procede, el solver utiliza el valor actualizado.

### 18.7 Kilometraje
`km máximos planificables = km lógicos estimados del servicio + 4 km de margen operativo`.

El odómetro fotografiado no interviene en el cálculo del solver.

## 19. Movilidad entre terminales

### 19.1 Bus Tránsito gratuito
Prioritario cuando sea temporalmente viable.

- `T1 → T2 → T4`
- `T4 → T3 → T2 → T1`
- 06:00–22:00: ~5 min frecuencia
- 22:00–06:00: ~20 min frecuencia

| Origen | Destino | Tiempo bus aprox. |
| --- | --- | ---: |
| T1 | T2 | 2 min |
| T1 | T4 | 10 min |
| T2 | T4 | 8 min |
| T4 | T3 | 8 min |
| T4 | T2 | 10 min |
| T4 | T1 | 15 min |

Matriz dirigida; no inventar simetría.

### 19.2 Acceso/espera
T1/T2/T3/T4: **5 min** de acceso por defecto. La espera no es fija: deriva de frecuencia/servicio y forma parte de la incertidumbre.

### 19.3 T4 ↔ T4S
Tren automático: **10 min** de acceso desde punto operativo, ~5 min de trayecto y espera variable.

## 20. Tiempo operativo
Cada `pickup` y `delivery` bloquea **10 min operativos**.

## 21. Transporte de compañeros
Restricción dura: `max_logistics_passengers_per_customer_vehicle = 1`.

Además del conductor, máximo un compañero. El informe debe indicar de forma especialmente visible cualquier recogida/traslado de compañero: quién, dónde, cuándo y hacia dónde.

## 22. Elegibilidad y asignaciones manuales — V1

### 22.1 Candidatos
Solo **operarios activos**. Un operario desactivado queda excluido. Root/Admin no se convierte en chófer por su rol salvo que el modelo actual lo identifique además como operario activo.

### 22.2 Equivalencia V1
No diferenciar por experiencia ni gama de vehículo en el reparto automático.

### 22.3 Asignaciones manuales: restricción dura e inmutable
Antes de invocar IA, el Admin puede configurar manualmente las tareas que considere necesarias.

Estas asignaciones:

- entran en el problema como compromisos existentes;
- ocupan tiempo y posición en el itinerario;
- condicionan el resto de movimientos;
- **no pueden ser modificadas, reasignadas ni propuestas para cambio por el solver**;
- permanecen intactas incluso al solicitar una nueva optimización.

El solver solo decide sobre tareas no fijadas y optimiza alrededor de las manuales.

## 23. Puntualidad e incertidumbre

### 23.1 Criticidad
`pickup` es crítica por riesgo de pérdida de vuelo. `delivery` es importante pero más flexible.

### 23.2 Objetivo
`target_arrival = scheduled_time - 5 min`.

### 23.3 Retrasos máximos
| Operación | Objetivo | Máximo |
| --- | --- | ---: |
| `pickup` | 5 min antes | +5 min |
| `delivery` | 5 min antes | +10 min |

Los retrasos son siempre soluciones no deseadas y la peor opción.

### 23.4 Prioridad
1. No superar máximo pickup.
2. No superar máximo delivery.
3. Evitar retraso pickup.
4. Evitar retraso delivery.
5. Llegar ≥5 min antes.
6. Después optimizar carga, tiempos muertos, km, etc.

### 23.5 Incertidumbre
Propagar incertidumbre de tráfico, Google Routes, bus, tren, accesos, dependencias con compañeros y márgenes operativos.

### 23.6 Hora de salida
`hora_salida_recomendada = target_arrival - tiempo_estimado_total - margen_por_incertidumbre`.

Debe calcularse desde Parking o desde cualquier punto de origen del operario.

## 24. Horizonte de planificación

Por defecto el Asistente IA propone **7 días / una semana**. El Admin puede cambiar el horizonte antes de optimizar (por ejemplo, próximos 3 días u otro intervalo personalizado).

El horizonte elegido determina las reservas/tareas cargadas, pero no autoriza al solver a modificar asignaciones manuales incluidas en dicho intervalo.

## 25. Workflow V1 de optimización, revisión y confirmación

### 25.1 Preparación manual
1. El Admin revisa Gestión/Asignación de tareas.
2. Si necesita reservar determinadas operaciones para personas concretas, las asigna manualmente mediante el flujo actual.
3. Estas asignaciones quedan fijadas.

### 25.2 Invocación del Asistente IA
4. El Admin pulsa el botón **Asistente IA**.
5. Se propone horizonte de una semana por defecto, modificable.
6. El backend vuelve a cargar estado real: tareas, asignaciones/versiones, operarios activos, matrices y reglas.
7. OR-Tools optimiza únicamente el conjunto permitido y genera itinerarios completos.
8. La IA convierte la solución técnica en informes operativos legibles.

### 25.3 Revisión antes de ejecutar
En esta fase **no se escriben todavía las nuevas asignaciones definitivas**.

El Admin recibe el plan completo y **todos los informes individuales** que posteriormente recibiría cada operario.

El Admin puede:

- aprobar la propuesta;
- rechazarla;
- solicitar una nueva optimización;
- proporcionar instrucciones adicionales válidas por chat y volver a calcular.

Una nueva optimización sigue respetando todas las asignaciones manuales existentes.

### 25.4 Confirmación única del plan
El plan se **confirma de una sola vez**. Antes de ejecutar se revalidan:

- identidad y permiso de escritura del Admin;
- versiones/concurrencia de las tareas;
- operarios activos;
- que las asignaciones manuales sigan intactas;
- que la propuesta corresponda al estado vigente.

Si el estado cambió de forma incompatible, no se aplica silenciosamente un plan obsoleto: se informa al Admin y se requiere recalcular/revisar.

### 25.5 Aplicación mediante workflow existente
Tras confirmación, las asignaciones automáticas aprobadas se ejecutan reutilizando el **mismo workflow/API de asignación manual existente** (`reservation-task-api` y mecanismos asociados), evitando crear un sistema paralelo.

Resultado:

- se actualiza la pantalla **Asignación de tareas**;
- se conservan exactamente las asignaciones manuales preestablecidas;
- las nuevas asignaciones quedan sujetas a los mismos mecanismos de versión, historial y notificación que las manuales.

## 26. Informes para operarios y Admin

### 26.1 Informe individual del operario
Después de la confirmación y aplicación correcta, cada operario recibe por Telegram un informe textual/calendario operativo con sus tareas e itinerario.

Debe incluir, según corresponda:

- fecha y hora;
- tipo: recogida/entrega;
- terminal;
- matrícula y datos operativos necesarios;
- hora recomendada de salida;
- medio de desplazamiento entre tareas;
- uso de Bus Tránsito o tren T4S cuando corresponda;
- indicaciones de traslado con otro operario;
- **si debe recoger a un compañero: nombre, punto, hora/ventana y destino**;
- si otro compañero lo recogerá: quién, dónde y cuándo;
- precauciones o dependencias relevantes para cumplir el plan.

La logística de compañeros debe mostrarse con especial claridad porque afecta simultáneamente a dos itinerarios.

### 26.2 Informe global del Admin
El Admin recibe **todos los informes individuales**, con el mismo contenido que se envía a cada trabajador. Así puede verificar qué instrucciones concretas recibió cada operario.

Antes de confirmar, el Admin ve esos mismos informes en modo propuesta. Después de confirmar, conserva/recibe la versión final efectivamente enviada.

### 26.3 Notificaciones existentes + informe Telegram
La confirmación debe conservar el flujo actual de notificaciones de asignación (`parking_booking_notifications` y Telegram donde ya aplique). El nuevo informe textual de planificación es **adicional**, no sustituye las notificaciones existentes.

## 27. Seguridad y autoridad del Asistente IA

### 27.1 Solo órdenes de usuarios con escritura
La IA **solo puede obedecer instrucciones de planificación procedentes de un usuario que, en ese momento, tenga permiso vigente de escritura** para el módulo/función correspondiente.

No basta con haber tenido permiso al iniciar la conversación. El permiso debe comprobarse nuevamente en cada mensaje/acción sensible y obligatoriamente antes de confirmar/aplicar el plan.

### 27.2 Aislamiento de mensajes y eventos
El sistema debe distinguir estrictamente entre:

- texto enviado por un Admin autorizado con escritura;
- mensajes/notificaciones generados por el bot;
- eventos del sistema;
- mensajes de operarios;
- mensajes de usuarios sin permiso de escritura.

Solo el primer grupo puede convertirse en instrucciones para modificar/reoptimizar/confirmar una planificación. Una notificación entrante nunca debe interpretarse como una orden para la IA.

### 27.3 Contexto por usuario y permisos cambiantes
La sesión/contexto de IA se mantiene por usuario, pero la autorización no se congela en la sesión. Si el permiso cambia a mitad de conversación, la siguiente acción debe aplicar el permiso vigente.

## 28. Principio de uso de Google
Google actúa como **sensor externo de calibración logística**, no como dependencia por cada tarea individual. Esto reduce coste y llamadas mientras permite capturar diferencias por horario y anomalías de la red viaria.
