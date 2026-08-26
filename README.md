# Mundwerk

Pfeifen wird ein Blasinstrument, Mundbeats werden Drums. Beides geht als MIDI
raus — mit Pitch Bend, Velocity und Channel Pressure, damit Schleifer und
Dynamik in der DAW nicht verloren gehen. Läuft komplett lokal im Browser.

```
npm install
npm run dev        # http://127.0.0.1:5173
```

Kein Framework, keine Laufzeit-Abhängigkeiten — Vite ist das ganze Setup.

## Ohne Mikrofon arbeiten

Im Dev-Server steht neben dem Aufnahmeknopf ein Auswahlfeld mit elf
Testaufnahmen aus `fixtures/`, dazu „Datei laden“ für eigenes Material. Die
Analyse ist derselbe Pfad wie bei einer Aufnahme.

```
npm test           # node --test gegen die Fixtures, kein Mikrofon nötig
npm run fixtures   # Fixtures neu erzeugen (deterministisch)
npm run build
```

## Build aus der Pipeline holen

`.github/workflows/build.yml` läuft bei jedem Push: `npm ci`, `npm test`,
`npm run build`. Das fertige `dist/` hängt als Artefakt am Lauf und wird von
GitHub als ZIP ausgeliefert — Actions → Lauf öffnen → unter „Artifacts“
`mundwerk-dist-<Nr>` laden. Der ZIP-Inhalt ist bereits der Wurzelinhalt des
Webverzeichnisses: entpacken, per SFTP hochladen, fertig. `BUILD.txt` daneben
sagt, aus welchem Commit das Paket stammt.

Liegt die Seite in einem festen Unterordner und soll ohne Schrägstrich am Ende
aufrufbar sein, den Lauf über „Run workflow“ starten und dort `base` auf z. B.
`/transformer/` setzen. Ohne Angabe baut die Pipeline mit relativen Pfaden.
Sourcemaps lassen sich im selben Dialog abwählen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/audio/pitch.js` | Tonhöhenerkennung (NSDF), Korrekturstufen, Notensegmentierung |
| `src/audio/onset.js` | Beat-Erkennung, Klassifikation, Tempo |
| `src/audio/synth.js` | Klangerzeugung, Offline-Rendering, WAV |
| `src/audio/midi.js` | MIDI-Export, Format 1 |
| `src/data/instruments.js` | Instrumente und Drumkits |
| `src/ui/` | Canvas und Bedienung |

`audio/` und `data/` sind frei von DOM: Samples rein, Zahlen raus. `pitch.js`
und `synth.js` sind für den späteren Swift-Port gedacht, `ui/` nicht.

Details zu den Entscheidungen (warum nicht quantisiert wird, Safari-Eigenheiten,
bekannte Schwächen der Analyse) stehen in [CLAUDE.md](CLAUDE.md).
