# ParkingMartin-G
## Asistente IA para asignación eficiente de operarios — Continuación

**Documento de continuación de:** `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`

Este documento continúa la especificación funcional y técnica del Asistente IA de planificación. Se crea de forma separada para evitar sobrescribir o perder las ampliaciones ya documentadas en el archivo principal. Debe leerse conjuntamente con dicho documento.

## 18. Matriz dinámica de trayectos mediante Google Routes

### 18.1 Objetivo

Google Routes no se utilizará para consultar individualmente el tiempo de cada recogida o entrega. Su función será **calibrar periódicamente la matriz logística de carretera** que consume el optimizador.

La finalidad es doble:

1. Capturar diferencias normales de tiempo de trayecto según la franja horaria.
2. Detectar anomalías puntuales que alteren significativamente los recorridos habituales, como obras, cortes, desvíos o congestión excepcional.

El flujo conceptual será:

`Solicitud de optimización → comprobar vigencia de matriz → Google Routes si procede → matriz dinámica → OR-Tools → propuesta de planificación → IA → confirmación Admin`

### 18.2 Nodos operativos

La matriz debe contemplar como mínimo los nodos operativos definidos en el modelo logístico:

- Parking
- T1
- T2
- T3
- T4
- T4S

La matriz es dirigida: `A → B` y `B → A` pueden tener distancia y duración diferentes.

### 18.3 Franjas horarias

Inicialmente se utilizarán cinco franjas operativas, definidas por comportamiento esperado del tráfico y no únicamente por nombres convencionales del día:

| Franja | Horario Europe/Madrid |
| --- | --- |
| `MADRUGADA` | 00:00–05:59 |
| `PUNTA_MANANA` | 06:00–09:59 |
| `VALLE_DIA` | 10:00–15:59 |
| `PUNTA_TARDE` | 16:00–19:59 |
| `NOCHE` | 20:00–23:59 |

Estas franjas deben ser **configurables y persistentes**. No deben quedar codificadas de forma rígida dentro del solver. Si los datos reales de operación muestran que otra segmentación representa mejor el tráfico, el Admin/sistema podrá modificar los límites sin cambiar OR-Tools.

### 18.4 Matriz por origen, destino y franja

Para cada combinación válida de:

`origen × destino × franja`

se almacenará como mínimo:

- distancia estimada;
- duración estimada actual;
- duración base/histórica de referencia;
- fecha/hora de obtención;
- fuente del dato;
- desviación respecto al valor base;
- indicador de anomalía cuando corresponda.

Campos conceptuales:

- `origin`
- `destination`
- `time_band`
- `distance_m`
- `baseline_duration_s`
- `current_duration_s`
- `deviation_pct`
- `fetched_at`
- `source`
- `is_anomaly`

Los nombres definitivos se decidirán al revisar el esquema real de Supabase antes de crear migraciones.

### 18.5 Actualización y caché

No se harán llamadas a Google por cada reserva. Los resultados se agrupan y reutilizan por nodo y franja horaria.

Antes de una optimización, el backend comprobará la antigüedad y validez de la matriz. Solo refrescará los datos que la política de vigencia determine necesarios.

Debe existir caché para evitar repetir consultas equivalentes durante una misma planificación o mientras los datos sigan considerándose válidos.

Con 6 nodos existen 30 trayectos dirigidos útiles si se excluyen los casos origen = destino. Con 5 franjas, una calibración completa representa como máximo 150 combinaciones origen-destino-franja, antes de aplicar optimizaciones adicionales de consulta/caché.

### 18.6 Detección de anomalías

El sistema comparará el tiempo actualizado con el tiempo base esperado para ese trayecto y franja.

Ejemplo conceptual:

`Parking → T4 / PUNTA_MANANA`

- tiempo base: 18 min
- tiempo actualizado: 29 min
- desviación: +61 %

Una desviación relevante debe poder marcar el trayecto como anómalo y hacer que el optimizador utilice el valor actualizado para esa planificación.

El umbral exacto de anomalía debe ser configurable; no debe fijarse arbitrariamente en esta fase de diseño.

### 18.7 Distancia y kilometraje de coches de clientes

Google puede actualizar tanto duración como distancia estimada del trayecto. La distancia alimenta las restricciones de kilometraje planificado de los coches de clientes.

Se mantiene la regla ya definida en el documento principal:

`km máximos planificables = km lógicos estimados del servicio + 4 km de margen operativo`

El odómetro fotografiado durante la operación **no forma parte del cálculo del optimizador**. La planificación trabaja con distancias estimadas.

### 18.8 Relación con la matriz de lanzaderas

La matriz de Google y la matriz de lanzaderas son fuentes distintas:

- Google Routes: desplazamientos por carretera.
- Matriz de lanzaderas: movilidad entre terminales mediante lanzadera.

Para lanzadera se mantiene:

- acceso desde el punto operativo de la terminal hasta la lanzadera: **5 minutos por defecto**;
- espera de lanzadera: **NO es un valor fijo**;
- la espera se calcula dinámicamente según la hora a la que el operario llega a la parada y la siguiente salida válida de la matriz de horarios/frecuencias;
- tiempo de viaje entre terminales: definido en la matriz de lanzaderas.

La lanzadera tiene prioridad cuando sea temporalmente viable y respete el resto de restricciones.

### 18.9 Tiempo operativo de recogidas y entregas

Cada `pickup` y cada `delivery` bloquean **10 minutos operativos** para la rutina del operario con el vehículo/cliente.

Durante esos 10 minutos el operario no está disponible para iniciar otro desplazamiento o tarea.

Para una transición mediante lanzadera, conceptualmente:

`fin/inicio operativo de tarea + 10 min de rutina + 5 min de acceso a lanzadera + espera calculada + trayecto de lanzadera → llegada a siguiente terminal`

La factibilidad se evalúa contra la ventana temporal de la siguiente tarea.

### 18.10 Transporte de compañeros en vehículos de clientes

Se mantiene como **restricción dura**:

`max_logistics_passengers_per_customer_vehicle = 1`

Además del operario conductor, un vehículo de cliente puede transportar como máximo **un compañero adicional** por necesidades logísticas del parking.

El optimizador automático nunca puede proponer dos o más acompañantes logísticos en un vehículo de cliente. La regla busca evitar un uso que el cliente pueda percibir como inadecuado de su vehículo para resolver necesidades internas del negocio.

Cualquier traslado de un compañero debe además:

- ser compatible con las ventanas temporales;
- respetar el límite de kilometraje estimado del coche;
- ser coherente con la ruta real del vehículo;
- reflejarse en los itinerarios de ambos operarios.

### 18.11 Asignaciones manuales existentes

Al optimizar un periodo se deben cargar primero las asignaciones manuales ya confirmadas dentro del horizonte.

Estas asignaciones se preservan como decisiones del Admin y el optimizador planifica alrededor de ellas, incluso cuando representen una excepción consciente a una regla automática.

Ejemplo: la asignación automática exige `GAMA_ALTA → EXPERTO`, pero si antes de ejecutar el optimizador un Admin ha asignado manualmente un vehículo de gama alta a un operario BAJO/MEDIO por una necesidad operativa, el solver no debe deshacer silenciosamente esa decisión. Debe preservarla y reflejarla como excepción manual en el informe.

### 18.12 Principio de uso de Google

Google debe actuar como **sensor externo de calibración logística**, no como dependencia por cada tarea individual.

Esto reduce coste, llamadas innecesarias y dependencia externa, mientras conserva el beneficio principal: que la planificación tenga en cuenta diferencias por horario y circunstancias anómalas de la red viaria.
