# Mundwerk

Pfeifen wird ein Blasinstrument, Mundbeats werden Drums. Aufnehmen im Browser,
anhören, als MIDI oder WAV rausgeben. Alles lokal, nichts verlässt das Gerät.

## Aufbau

```
src/audio/pitch.js       NSDF-Erkennung, medianFix/octaveFix, shapedCurve, segmentNotes
src/audio/onset.js       Bandfilter, Hüllkurven, detectHits, estimateBPM, gridded
src/audio/synth.js       renderMelody, renderBeat, renderMix, toWav
src/audio/midi.js        buildMidi + SMF-Hilfsfunktionen
src/data/instruments.js  INSTRUMENTS, KITS, GM-Zuordnung
src/ui/canvas.js         drawMelody, drawBeat, drawLive
src/ui/app.js            Zustand, Regler, Events
```

`pitch.js`, `onset.js` und `midi.js` sind reine Zahlenverarbeitung: Float32Array
und Samplerate rein, Werte raus. Kein DOM, kein WebAudio, kein Zugriff auf
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

**Kein Persistenzbedarf.** Aufnahmen sind flüchtig, es gibt keinen Speicher, und
es braucht auch keinen Ersatz für localStorage. Neu laden heißt neu anfangen.

## Constraints

**`setValueCurveAtTime` verträgt keine überlappende Automation.** Pro AudioParam
entweder *eine* Kurve über die gesamte Dauer oder ausschließlich
`setValueAtTime`/Rampen — nie beides, nie zwei Kurven. Safari wirft, Chrome
verschluckt es still und liefert falschen Klang. `renderMelody` hält sich daran.

**Safari.**
- `webkitAudioContext` / `webkitOfflineAudioContext` als Fallback, siehe `app.js` und `synth.js`.
- Der AudioContext startet suspendiert; `resume()` geht nur aus einer Nutzergeste. Jeder Pfad, der Ton macht, hängt an einem Klick.
- `decodeAudioData` gibt kein Promise zurück — beide Formen bedienen (`decode()` in `app.js`).
- Mikrofon braucht einen sicheren Kontext. localhost zählt, eine LAN-IP nicht.

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

## Bekannte Schwächen

Als `todo`-Tests hinterlegt, laufen also mit, ohne die Suite rot zu machen:

1. **Hallfahnen verschmelzen Phrasen.** Bei verhalltem Pfeifen bleibt die Fahne
   stimmhaft, die Pause fällt aus, drei Töne werden eine Note.
   (`test/pitch.test.js`, `whistle-reverb.wav`)
2. **Hi-Hats werden als offen gemeldet.** `detectHits` misst die Abklingdauer
   350 ms voraus und läuft dabei in den nächsten Schlag. Ab etwa 170 BPM ist
   jede Hi-Hat „openhat“. (`test/onset.test.js`)
3. **Ausläufer färben die Klassifikation.** Das 30-ms-Fenster nach dem Einsatz
   misst den Vorgänger mit; in dichten Mustern kippen Hi-Hats direkt nach einer
   Kick zu Snare oder Kick. (`test/onset.test.js`, `beat-fast.wav`)

Alle drei sind Fehler in der Analyse, nicht in den Fixtures. Wer sie angeht:
erst den `todo`-Marker entfernen, dann grün machen.
