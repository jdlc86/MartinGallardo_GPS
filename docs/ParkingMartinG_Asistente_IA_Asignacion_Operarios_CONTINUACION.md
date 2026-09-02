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

Inicialmente se utilizarán cinco franjas operativas:

| Franja | Horario Europe/Madrid |
| --- | --- |
| `MADRUGADA` | 00:00–05:59 |
| `PUNTA_MANANA` | 06:00–09:59 |
| `VALLE_DIA` | 10:00–15:59 |
| `PUNTA_TARDE` | 16:00–19:59 |
| `NOCHE` | 20:00–23:59 |

Estas franjas deben ser **configurables y persistentes** y no quedar codificadas rígidamente dentro del solver.

### 18.4 Matriz por origen, destino y franja

Para cada combinación `origen × destino × franja` se almacenará como mínimo distancia estimada, duración actual, duración base/histórica, fecha de obtención, fuente, desviación e indicador de anomalía.

Campos conceptuales: `origin`, `destination`, `time_band`, `distance_m`, `baseline_duration_s`, `current_duration_s`, `deviation_pct`, `fetched_at`, `source`, `is_anomaly`.

### 18.5 Actualización y caché

No se harán llamadas a Google por cada reserva. Los resultados se agrupan y reutilizan por nodo y franja horaria. Antes de una optimización, el backend comprobará la antigüedad y validez de la matriz y refrescará únicamente lo necesario.

Con 6 nodos existen 30 trayectos dirigidos útiles excluyendo origen=destino. Con 5 franjas, una calibración completa representa como máximo 150 combinaciones origen-destino-franja antes de aplicar caché u otras optimizaciones.

### 18.6 Detección de anomalías

El sistema comparará el tiempo actualizado con el tiempo base esperado para ese trayecto y franja. Una desviación relevante debe poder marcar el trayecto como anómalo y hacer que el optimizador utilice el valor actualizado. El umbral de anomalía será configurable.

### 18.7 Distancia y kilometraje de coches de clientes

Google puede actualizar tanto duración como distancia estimada. Se mantiene:

`km máximos planificables = km lógicos estimados del servicio + 4 km de margen operativo`

El odómetro fotografiado durante la operación no forma parte del cálculo del optimizador.

## 19. Movilidad entre terminales

### 19.1 Bus Tránsito gratuito T1/T2/T3/T4

La movilidad entre T1, T2, T3 y T4 utilizará como opción prioritaria el Bus Tránsito gratuito del aeropuerto cuando sea temporalmente viable.

Recorridos publicados:

- sentido hacia T4: `T1 → T2 → T4`;
- sentido desde T4: `T4 → T3 → T2 → T1`.

Frecuencia operativa de referencia:

- 06:00–22:00: aproximadamente cada 5 minutos;
- 22:00–06:00: aproximadamente cada 20 minutos.

Tiempos iniciales de trayecto para alimentar la matriz:

| Origen | Destino | Tiempo de bus aproximado |
| --- | --- | ---: |
| T1 | T2 | 2 min |
| T1 | T4 | 10 min |
| T2 | T4 | 8 min |
| T4 | T3 | 8 min |
| T4 | T2 | 10 min |
| T4 | T1 | 15 min |

La matriz es dirigida y no se debe inventar simetría entre trayectos no publicados.

### 19.2 Acceso y espera del Bus Tránsito

Para T1/T2/T3/T4 se establece un tiempo de **5 minutos por defecto** desde el punto operativo de recogida/entrega hasta la parada de la lanzadera.

La espera de la lanzadera **no se fija como constante**. Se deriva de la frecuencia/servicio disponible en el momento del desplazamiento. El modelo debe incorporar la incertidumbre asociada a dicha espera y no asumir una salida exacta inexistente.

### 19.3 T4 ↔ T4S: tren automático

T4 ↔ T4S se trata como un medio de transporte diferente del Bus Tránsito.

Reglas iniciales:

- acceso desde el punto operativo de recogida/entrega hasta el tren: **10 minutos**;
- este acceso sustituye los 5 minutos estándar utilizados para la lanzadera de T1/T2/T3/T4;
- tiempo aproximado de trayecto en tren: 5 minutos;
- espera: variable según la frecuencia del tren y debe incorporarse a la incertidumbre del trayecto.

## 20. Tiempo operativo de cada servicio

Cada `pickup` y cada `delivery` bloquean **10 minutos operativos** para la rutina del operario con el vehículo/cliente. Durante ese bloque el operario no está disponible para iniciar otro desplazamiento o tarea.

## 21. Transporte de compañeros en vehículos de clientes

Restricción dura:

`max_logistics_passengers_per_customer_vehicle = 1`

Además del conductor, un vehículo de cliente puede transportar como máximo un compañero adicional por necesidades logísticas. El optimizador nunca puede proponer dos o más acompañantes logísticos. Todo traslado debe respetar ventanas temporales, kilometraje estimado y coherencia de rutas, y reflejarse en los itinerarios de ambos operarios.

## 22. Asignaciones manuales existentes

Al optimizar un periodo se cargan primero las asignaciones manuales ya confirmadas. Se preservan como decisiones del Admin y el solver planifica alrededor de ellas, incluso si representan una excepción consciente a una regla automática como `GAMA_ALTA → EXPERTO`. La excepción debe reflejarse en el informe.

## 23. Política de puntualidad, criticidad e incertidumbre

### 23.1 Diferencia entre pickup y delivery

Las dos operaciones requieren puntualidad, pero sus consecuencias son diferentes:

- `pickup` (recogida del coche al cliente que va a viajar): **operación crítica**. Un retraso puede contribuir a que el cliente pierda su vuelo.
- `delivery` (devolución del coche al cliente que llega al aeropuerto): **operación importante pero más flexible**. Un retraso genera espera y deteriora el servicio, pero normalmente no implica riesgo de perder un vuelo.

Esta asimetría debe formar parte explícita de la función objetivo y de las restricciones temporales.

### 23.2 Política normal: llegar 5 minutos antes

La política de servicio es que el operario llegue al punto de recogida/entrega **5 minutos antes de la hora programada**.

Por tanto, el objetivo temporal preferido para cualquier tarea es:

`target_arrival = scheduled_time - 5 min`

Llegar después de este objetivo no se considera equivalente a una solución puntual: debe introducir penalización en la optimización.

### 23.3 Retrasos máximos tolerables como peor opción

Los retrasos son escenarios no deseados y solo deben aparecer cuando no exista una solución mejor dentro de las restricciones globales.

Límites:

| Operación | Objetivo | Retraso máximo tolerable |
| --- | --- | ---: |
| `pickup` | llegar 5 min antes | **5 min** después de la hora programada |
| `delivery` | llegar 5 min antes | **10 min** después de la hora programada |

Superar estos límites debe tratarse como solución no factible para la planificación automática, salvo que posteriormente se defina un mecanismo explícito de excepción manual del Admin.

### 23.4 Jerarquía de penalización temporal

El solver debe favorecer las soluciones aproximadamente en este orden:

1. Nunca superar el retraso máximo permitido de un `pickup`.
2. Nunca superar el retraso máximo permitido de un `delivery`.
3. Evitar cualquier retraso en `pickup`, incluso dentro de los 5 minutos tolerables.
4. Evitar retrasos en `delivery`, aunque sean inferiores a 10 minutos.
5. Buscar llegar al menos 5 minutos antes en ambos tipos de tarea.
6. Solo después optimizar tiempos muertos, balance de carga, kilómetros y demás objetivos blandos, sin violar las restricciones duras.

La penalización por retraso de `pickup` debe ser significativamente mayor que la de `delivery`.

### 23.5 Propagación de incertidumbre

El optimizador no debe trabajar únicamente con la suma de tiempos medios. Debe considerar la **incertidumbre acumulada del itinerario propuesto** para calcular una hora de salida suficientemente robusta.

Entre las fuentes de incertidumbre se incluyen:

- variación del tráfico de carretera y anomalías detectadas mediante Google Routes;
- espera del Bus Tránsito;
- espera del tren T4↔T4S;
- transiciones entre punto operativo y parada/estación;
- dependencias de traslado con otro operario;
- cualquier margen operacional configurable que se incorpore posteriormente.

La incertidumbre se propaga a través de la cadena de movimientos. Una secuencia con más transbordos o dependencias puede requerir una salida más temprana que otra con el mismo tiempo medio pero menor variabilidad.

### 23.6 Cálculo de hora recomendada de salida

El resultado del optimizador debe incluir no solo la asignación y el itinerario, sino también la **hora recomendada de salida desde el Parking o desde cualquier punto de origen**.

Conceptualmente:

`hora_salida_recomendada = target_arrival - tiempo_estimado_total - margen_por_incertidumbre`

El `margen_por_incertidumbre` no debe ser una constante universal: depende del trayecto propuesto y de las fuentes de incertidumbre presentes.

Ejemplo de salida para el operario:

- tarea: pickup T1 a las 10:00;
- objetivo: estar en T1 a las 09:55;
- hora de salida recomendada: calculada por el solver según ruta, tráfico, transporte y riesgo;
- llegada estimada y margen previsto: incluidos en el informe.

### 23.7 Itinerario robusto, no solo itinerario más rápido

La solución óptima no debe ser necesariamente la que tenga el menor tiempo medio. Debe favorecer el itinerario que reduzca el riesgo de incumplimiento, especialmente en `pickup`.

Una ruta ligeramente más lenta pero estable puede ser preferible a otra más rápida en promedio pero con alta incertidumbre si esta última aumenta el riesgo de llegar tarde a una recogida crítica.

## 24. Principio de uso de Google

Google debe actuar como **sensor externo de calibración logística**, no como dependencia por cada tarea individual. Esto reduce coste, llamadas innecesarias y dependencia externa, manteniendo la capacidad de detectar diferencias por horario y circunstancias anómalas de la red viaria.
