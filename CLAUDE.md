# Mundwerk

Pfeifen wird ein Blasinstrument, Mundbeats werden Drums. Aufnehmen im Browser,
anhören, als MIDI oder WAV rausgeben. Alles lokal, nichts verlässt das Gerät.

## Aufbau

```
src/audio/pitch.js       NSDF-Erkennung, medianFix/octaveFix, shapedCurve, segmentNotes
src/audio/onset.js       Bandfilter, Hüllkurven, detectHits, estimateBPM, gridded
src/audio/synth.js       renderMelody, renderBeat, renderMix, toWav
src/audio/midi.js        buildMidi, buildMpe + SMF-Hilfsfunktionen
src/audio/curve.js       melodyCurve, beatCurve, hitTable, toCsv, toJson
src/data/instruments.js  INSTRUMENTS, KITS, GM-Zuordnung
src/ui/canvas.js         drawMelody, drawBeat, drawLive
src/ui/app.js            Zustand, Regler, Events
```

`pitch.js`, `onset.js`, `midi.js` und `curve.js` sind reine Zahlenverarbeitung:
Float32Array und Samplerate rein, Werte raus. Kein DOM, kein WebAudio, kein Zugriff auf
Regler. Sie sollen später nach Swift portiert werden — **wer dort einen
`document.getElementById` oder eine Reglerabfrage einbaut, macht den Port
kaputt**. Reglerwerte werden in `ui/app.js` gelesen und als Parameter
durchgereicht. `synth.js` braucht WebAudio und wird beim Port durch
AVAudioEngine ersetzt. `ui/` fliegt raus.

## Entscheidungen, die keine Bugs sind

**Es wird nicht quantisiert.** Weder in der Zeit noch auf Halbtöne — außer der
Nutzer zieht die Regler „Auf Halbtöne ziehen“ bzw. „Aufs Raster ziehen“ selbst
hoch. Beide stehen auf 0. Ein Glissando soll ein Glissando bleiben; die Kontur
geht als Pitch Bend ins MIDI, nicht als Treppe aus Einzelnoten.

**Eine Note pro Phrase, nicht pro Tonhöhe.** `segmentNotes` fängt erst dann eine
neue Note an, wenn die Tonhöhe weiter vom Grundton wegläuft als der Bend-Umfang
abbilden kann. Bei ±12 Halbtönen wird aus einer durchgezogenen Phrase über eine
Oktave *eine* Note mit Bend-Kurve. Das ist Absicht.

**Nur der Pfeifbereich.** `FMIN = 380`, `FMAX = 4200`. Summen und Sprechen
liegen darunter und werden bewusst nicht erkannt.

**Im Zweifel geschlossen.** Ob eine Hi-Hat offen ist, entscheidet die
Abklingdauer im hohen Band. Steht der nächste Schlag so dicht, dass die Fahne
gar nicht zu beobachten ist, gilt sie als geschlossen. Lieber eine offene
Hi-Hat verpassen als bei jedem schnellen Muster falsche `openhat` liefern.

**Kein Persistenzbedarf.** Aufnahmen sind flüchtig, es gibt keinen Speicher, und
es braucht auch keinen Ersatz für localStorage. Neu laden heißt neu anfangen.

**Der Bend-Umfang ist ein Regler für beide MIDI-Formate.** Er entscheidet nicht
nur, was in RPN 0 landet, sondern auch, wann `segmentNotes` eine neue Note
anfängt — deshalb gibt es keinen zweiten Regler für MPE. Nur Obergrenze und
Vorgabe unterscheiden sich (klassisch ±24 / ±12, MPE ±96 / ±48). Beim Umschalten
ändert sich sichtbar die Notenzahl, und das ist der Punkt: bei ±48 passt eine
gepfiffene Phrase fast immer in eine einzige Note mit Kurve.

**Die MPE-Zone schrumpft, wenn Drums dabei sind.** Eine volle untere Zone belegt
die Kanäle 2–16 und damit auch Kanal 10, wo die GM-Percussion liegt. Liegt ein
Beat vor, bekommt die Zone acht statt fünfzehn Member-Kanäle. Die Melodiespur
ist einstimmig; die Rotation dient nur dazu, dass der Bend einer ausklingenden
Note nicht in die nächste hineinregiert.

**Der Bend-Umfang steht im MPE-Export auf jedem Member-Kanal.** Laut
Spezifikation genügt einer, weil RPN 0 auf einem Member für die ganze Zone gilt.
Genau dieses „genügt eigentlich“ ist aber der Stolperstein, an dem Importe still
auf ±2 stehenbleiben. Fünfzehnmal vier Bytes sind der Preis dafür, ihn zu
umgehen.

**CC74 im MPE-Export ist gemessen, nicht erfunden.** Die Y-Achse trägt, wie hoch
im Umfang *dieser Aufnahme* gerade gepfiffen wird (`centsSpan`/`normPos` in
`pitch.js`). Bezugsgröße ist bewusst die Aufnahme und nicht `FMIN..FMAX` — über
den festen Pfeifbereich normiert bliebe von einer Terz ein Zwanzigstel des Wegs
übrig. Dieselbe Größe steht im Kurven-Export in der Spalte `norm`. Wer eine
dritte Dimension will, die niemand gepfiffen hat, zeichnet sie in der DAW.

**Im Kurven-Export sind unstimmhafte Frames Nullen, keine Lücken.** Eine
Modulationsquelle darf keine Löcher haben; `voiced` ist die einzige Spalte, die
zwischen „gemessen“ und „nur Füllung“ unterscheidet. `hz` folgt den Reglern,
`hz_raw` nicht — wer die unbearbeitete Erkennung will, nimmt die zweite Spalte.

## Constraints

**Offline wird mit der Rate des Ausgabekontexts gerendert, nicht mit der der
Quelle.** Eine geladene Datei bringt ihre eigene Samplerate mit, und iOS-Safari
mag einen `OfflineAudioContext`, dessen Rate nicht zur Hardware passt, gar
nicht. `renderMix` bekommt deshalb `sr` (für die Dauer) und `renderRate` (für
die Puffergröße) getrennt.

**`setValueCurveAtTime` verträgt keine überlappende Automation.** Pro AudioParam
entweder *eine* Kurve über die gesamte Dauer oder ausschließlich
`setValueAtTime`/Rampen — nie beides, nie zwei Kurven. Safari wirft, Chrome
verschluckt es still und liefert falschen Klang. `renderMelody` hält sich daran.

**Safari.**
- `webkitAudioContext` / `webkitOfflineAudioContext` als Fallback, siehe `app.js` und `synth.js`.
- Der AudioContext startet suspendiert; `resume()` geht nur aus einer Nutzergeste. Jeder Pfad, der Ton macht, hängt an einem Klick.
- `decodeAudioData` gibt kein Promise zurück — beide Formen bedienen (`decode()` in `app.js`).
- **`startRendering()` gibt ebenfalls kein Promise zurück.** Der Puffer kommt
  über `oncomplete`. Wer nur das Promise nimmt, bekommt `undefined` — kein
  Wurf, keine Meldung, kein Ton. `startRendering()` in `synth.js` bedient beide
  Formen, `test/synth.test.js` hält das fest.
- **Neben `suspended` gibt es `interrupted`.** Steht nicht in der
  Spezifikation, kommt nach Anruf, Siri oder App-Wechsel und braucht dasselbe
  `resume()`. Wer nur auf `suspended` prüft, spielt lautlos weiter.
- Mikrofon braucht einen sicheren Kontext. localhost zählt, eine LAN-IP nicht.

**Nach dem Aufnehmen muss der AudioContext weg.** iOS schaltet die
Audio-Session beim ersten `createMediaStreamSource` auf „aufnehmen und
abspielen" und legt die Ausgabe damit auf den Hörer statt auf den
Lautsprecher. Die Mikrofonspur zu stoppen reicht nicht — solange derselbe
Kontext lebt, bleibt die Session in diesem Modus, und alles danach klingt nach
nichts. `dropRecordingCtx()` in `app.js` schließt ihn, `ensureCtx()` baut beim
nächsten Antippen einen neuen. Wer den Kontext wieder über die Aufnahme hinaus
am Leben lässt, macht die Wiedergabe auf dem iPhone wieder kaputt.

**Auf iOS entscheidet der Stummschalter über WebAudio.** Ein `<audio>`-Element
spielt bei stummgeschaltetem Klingelton weiter, WebAudio nicht. Das ist keine
Sache des Codes; bleibt es nach allem oben still, gehört der Schalter am Rand
des Geräts geprüft.

**ScriptProcessorNode statt AudioWorklet.** Veraltet, aber überall gleich und für
20 Sekunden Mono völlig ausreichend. Kein Grund zum Umbau.

**Kein Framework, keine Laufzeit-Abhängigkeit.** Nur Vite als Build. Bitte so lassen.

## Arbeiten

```
npm run dev        Vite mit Hot Reload auf 127.0.0.1:5173
npm test           node --test, läuft gegen fixtures/, kein Mikrofon nötig
npm run fixtures   erzeugt fixtures/ neu (deterministisch)
npm run build
```

**Nach jeder Änderung an `audio/` erst `npm test`.** Die Fixtures sind der
einzige Weg zu sehen, ob eine Änderung besser oder nur anders ist. Zum Prüfen im
Browser gibt es im Dev-Server das Auswahlfeld „Testaufnahme …“ neben dem
Aufnahmeknopf — nichts reinpfeifen müssen.

Ändert eine Änderung absichtlich das Analyseergebnis, gehört die neue Erwartung
in `fixtures/manifest.json` bzw. in den Test — nicht die Toleranz hochgedreht.

## Wie ein Schlag eingeordnet wird

`classify()` in `onset.js` misst nicht die absolute Bandenergie nach dem
Einsatz, sondern den **Zuwachs** gegenüber dem, was unmittelbar davor schon
anlag (Minimum der drei Frames davor). Ohne diesen Abzug zählt die abklingende
Fahne des Vorgängers mit, und eine Hi-Hat direkt nach einer Kick sieht aus wie
eine Snare.

Beide Messfenster enden spätestens am **nächsten Einsatz**. Deshalb läuft
`detectHits` in zwei Durchgängen: erst alle Einsatzframes sammeln, dann
klassifizieren — die Fenstergrenze steht sonst nicht fest.

Wer daran etwas ändert, sollte vorher `test/onset.test.js` lesen. Die Tests dort
prüfen beide Richtungen: geschlossene Hi-Hats dürfen nicht offen werden *und*
offene müssen offen bleiben. Ein Fix, der `openhat` einfach nie mehr vergibt,
fällt durch.

## Bekannte Schwächen

Als `todo`-Tests hinterlegt, laufen also mit, ohne die Suite rot zu machen:

1. **Hallfahnen verschmelzen Phrasen.** Bei verhalltem Pfeifen bleibt die Fahne
   stimmhaft, die Pause fällt aus, drei Töne werden eine Note.
   (`test/pitch.test.js`, `whistle-reverb.wav`)
2. **Die Kick löst doppelt aus.** Etwa 90 ms nach einer Kick meldet die
   Flusserkennung einen zweiten Einsatz — je nach Fixture drei bis fünf zu viel.
   Die Refraktärzeit von 55 ms greift dagegen nicht, und sie hochzudrehen würde
   Sechzehntel ab 140 BPM verschlucken. (`test/onset.test.js`)

Beide sind Fehler in der Analyse, nicht in den Fixtures. Wer sie angeht: erst
den `todo`-Marker entfernen, dann grün machen.
