# Fixtures

Synthetische Testaufnahmen. Damit man nach jeder Änderung an `src/audio/`
vergleichen kann, ob es besser wurde, statt jedes Mal neu ins Mikrofon zu
pfeifen — und damit `npm test` ohne Mikrofon durchläuft.

Erzeugt mit `npm run fixtures` (`scripts/make-fixtures.mjs`). Alles
deterministisch: eigener LCG statt `Math.random()`, also byte-gleich auf jedem
Rechner. 44,1 kHz, 16 Bit, mono.

`manifest.json` enthält zu jeder Datei die erwartete Ground Truth — bei
Melodien die Noten mit Zeiten, bei Beats Schläge und Tempo. Die Werte kommen
aus den **Syntheseparametern**, nicht aus einem Analyselauf; sonst würde der
Test nur bestätigen, was der Code ohnehin gerade tut.

| Datei | Was es prüft |
|---|---|
| `whistle-clean.wav` | der Normalfall: fünf Töne, klare Pausen |
| `whistle-vibrato.wav` | starkes Vibrato darf die Note nicht zerlegen |
| `whistle-reverb.wav` | Hallfahne — bekannte Schwäche, siehe CLAUDE.md |
| `whistle-noisy.wav` | Raumrauschen unter dem Ton |
| `whistle-octave-bait.wav` | kräftiger zweiter Teilton, Köder für `octaveFix` |
| `whistle-glide.wav` | Glissando über neun Halbtöne: eine Note, Bend trägt die Kontur |
| `error-quiet.wav` | unter dem RMS-Gate: muss `null` liefern, nicht raten |
| `error-noise.wav` | nur Rauschen: dito |
| `beat-simple.wav` | Kick/Snare/Hat, 100 BPM, jeder Schlag auf eigenem Sechzehntel |
| `beat-fast.wav` | dichte Sechzehntel, 140 BPM — Hi-Hat direkt nach der Kick |
| `beat-openhat.wav` | offene Hi-Hat am Taktende, mit Luft dahinter |

Zwei Schläge zur exakt gleichen Zeit sind für eine Onset-Erkennung per
Definition *ein* Einsatz — die Muster setzen deshalb nie Kick und Hi-Hat auf
denselben Zeitpunkt.

`beat-openhat.wav` gibt es aus einem bestimmten Grund: alle anderen Beats
enthalten nur geschlossene Hi-Hats. Ein Fix, der `openhat` einfach nie mehr
vergibt, würde ohne diese Fixture die ganze Suite bestehen. Die offene Hi-Hat
sitzt deshalb am Taktende, mit drei Sechzehnteln Luft dahinter — anders lässt
sich eine Abklingdauer gar nicht messen.

Die Dateien liegen absichtlich außerhalb von `public/`: der Dev-Server
liefert sie unter `/fixtures/…` aus, `vite build` nimmt sie nicht mit.

Eigene Aufnahmen einfach über „Datei laden“ in die App ziehen — WAV, MP3, M4A,
alles was der Browser dekodiert.
