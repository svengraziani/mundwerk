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

Im Dev-Server steht neben dem Aufnahmeknopf ein Auswahlfeld mit zehn
Testaufnahmen aus `fixtures/`, dazu „Datei laden“ für eigenes Material. Die
Analyse ist derselbe Pfad wie bei einer Aufnahme.

```
npm test           # node --test gegen die Fixtures, kein Mikrofon nötig
npm run fixtures   # Fixtures neu erzeugen (deterministisch)
npm run build
```

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
