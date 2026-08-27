# Mundwerk

Pfeifen wird ein Blasinstrument, Gesungenes auch, Mundbeats werden Drums.
Alles geht als MIDI raus — klassisch oder als MPE, mit Pitch Bend, Velocity und
Druck, damit Schleifer und Dynamik in der DAW nicht verloren gehen. Wer die
Kurve selbst braucht, holt sie als CSV oder JSON. Läuft komplett lokal im
Browser.

Eine Aufnahme darf bis zu **eine Minute** lang sein. Im Melodie-Modus steht
über der Spur ein Schalter für die Quelle: **Pfeifen** sucht zwischen 380 und
4200 Hz, **Gesang** zwischen 75 und 1200 Hz — damit sind gesungene Vokale,
Lalala und Summen abgedeckt, von E2 bis in die Sopranlage. Umschalten geht auch
nach der Aufnahme; die Rohaufnahme bleibt liegen und wird neu ausgewertet.

```
npm install
npm run dev        # http://127.0.0.1:5173
```

Kein Framework, keine Laufzeit-Abhängigkeiten — Vite ist das ganze Setup.

## Ohne Mikrofon arbeiten

Im Dev-Server steht neben dem Aufnahmeknopf ein Auswahlfeld mit fünfzehn
Testaufnahmen aus `fixtures/`, dazu „Datei laden“ für eigenes Material. Die
Analyse ist derselbe Pfad wie bei einer Aufnahme; eine Testaufnahme stellt Modus
und Quelle gleich mit ein.

```
npm test           # node --test gegen die Fixtures, kein Mikrofon nötig
npm run fixtures   # Fixtures neu erzeugen (deterministisch)
npm run build
```

## Was rauskommt

**MIDI, klassisch.** Format 1, 480 PPQ. Melodie auf Kanal 1, Drums auf Kanal 10.
Pitch Bend alle 16 ms, Channel Pressure und CC11 alle 40 ms. Der Bend-Umfang
steht als RPN 0 in der Datei und muss im Ziel-Instrument gleich eingestellt
sein.

**MIDI als MPE.** Untere Zone, Kanal 1 als Master, die Anzahl der Stimmkanäle
als MPE Configuration Message. Jede Note wandert reihum auf einen eigenen
Member-Kanal — Bend und Druck gelten damit genau dieser Stimme. Dazu CC74 als
Y-Achse: wie hoch im Umfang der Aufnahme gerade gepfiffen oder gesungen wird. Der Bend-Umfang
steht auf jedem Member-Kanal, nicht nur auf einem; damit stellt sich das
Ziel-Instrument selbst richtig ein. Liegt ein Beat dabei, wird die Zone
kleiner, damit Kanal 10 für die Drums frei bleibt.

**Rohkurve als CSV oder JSON.** Die Analyse ohne Notenraster, wahlweise im
Analyse-Raster oder auf 200/100/50 Hz interpoliert:

```
t_s,hz,hz_raw,midi,amp,norm,voiced
0.5900,660.052,1320.104,76.0209,0.99706,0.99591,1
```

`hz` nach den Reglern, `hz_raw` wie erkannt, `midi` als gebrochene Notennummer,
`amp` die Lautstärke 0..1, `norm` die Lage im Umfang dieser Aufnahme (0 beim
tiefsten, 1 beim höchsten Ton) und `voiced` als Flagge, ob der Wert gemessen
oder nur Füllung ist. Beim Beat kommen stattdessen die drei Bandhüllkurven und
eine Tabelle der Schläge. Das JSON enthält dieselben Werte spaltenweise plus
die Reglerstellung, unter der sie entstanden sind.

## Deploy auf Netcup/Plesk per `git pull`

Plesk zieht das Repo direkt nach `httpdocs/`. Ausgeliefert wird aber nur der
Build, und dafür sorgt die `.htaccess` im Wurzelverzeichnis: sie schreibt jede
Anfrage nach `dist/` um — `/` auf `dist/index.html`, `/assets/…` auf
`dist/assets/…`. Alles andere (`src/`, `test/`, `fixtures/`, `package.json`)
landet ebenfalls unter `dist/` und damit im 404, ist also von außen nicht zu
sehen. `.git/` wird zusätzlich hart abgewiesen.

Weil auf dem Server nichts gebaut wird, liegt `dist/` im Repo. Von Hand
mitcommitten muss man es aber nicht: Bei jedem Push auf `main` baut die
Pipeline und schiebt das Ergebnis als eigenen Commit hinterher
(`Build: dist/ aus <commit> [skip ci]`). Wer auf `main` pusht, findet dort
kurz darauf den passenden Build. Danach in Plesk „Pull“ auslösen oder den
Webhook laufen lassen — mehr passiert auf dem Server nicht.
`dist/BUILD.txt` sagt, aus welchem Commit der liegende Stand gebaut wurde.

Zwei Dinge müssen dafür stimmen:

* Settings → Actions → General → Workflow permissions steht auf
  **„Read and write permissions“**. Sonst ist der Token trotz `contents: write`
  schreibgeschützt und der Push scheitert mit 403 — der Lauf wird rot und sagt
  das auch.
* Schützt eine Branch-Regel `main`, braucht sie eine Ausnahme für
  `github-actions[bot]`.

**Auf Feature-Branches macht die Pipeline das absichtlich nicht.** Zwei
Branches mit je eigenem Build kollidieren beim Merge in denselben gehashten
Dateinamen. Dort also `dist/` in Ruhe lassen; nach dem Merge baut der Lauf auf
`main` den richtigen Stand. Ein Build von Hand ist nur nötig, wenn die Pipeline
mal nicht kann:

```
npm test
npm run build
git add dist && git commit
```

Das Mikrofon braucht einen sicheren Kontext: ohne HTTPS bleibt der
Aufnahmeknopf tot. In Plesk dafür „Dauerhafte SEO-sichere 301-Umleitung von
HTTP zu HTTPS“ setzen; die `.htaccess` enthält denselben Umweg als
auskommentierten Notnagel.

### In einem Unterordner neben WordPress

Liegt in `httpdocs/` ein WordPress und das Repo darunter in
`httpdocs/transformer/`, funktioniert dieselbe `.htaccess` unverändert — sie
enthält absichtlich kein `RewriteBase`. Wer dort `RewriteBase /` einträgt,
landet im WordPress: die Regeln zeigen dann auf `/dist/…` in der Wurzel, das
gibt es nicht, und die `.htaccess` des WordPress reicht die Anfrage an ihre
`index.php` weiter.

Landet man trotzdem im WordPress, der Reihe nach prüfen:

* Liegt die `.htaccess` wirklich in `httpdocs/transformer/` und nicht nur in
  der Wurzel? Plesk zeigt versteckte Dateien nur mit gesetztem Haken an.
* Wird der Ordner mit Schrägstrich am Ende aufgerufen (`…/transformer/`)? Ohne
  ihn zeigen die relativen Asset-Pfade des Builds ins Leere. Für einen festen
  Unterpfad ohne diese Bedingung mit `BASE=/transformer/ npm run build` bauen.
* Ist `AllowOverride` für das Verzeichnis aktiv? Ohne das wird die `.htaccess`
  gar nicht gelesen und der Server fällt auf die Regeln der Wurzel zurück.
* Steht in der vHost-Konfiguration `RewriteOptions Inherit`, greifen die
  WordPress-Regeln auch hier unten. Dann in diesem Ordner
  `RewriteOptions Ignore Inherit` ergänzen.
* Bleibt es dabei, den Pfad in der `.htaccess` fest eintragen: die Zeile
  `RewriteBase /transformer/` steht dort auskommentiert bereit.

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
| `src/audio/midi.js` | MIDI-Export, Format 1 — klassisch und MPE |
| `src/audio/curve.js` | Rohkurven-Export, CSV und JSON |
| `src/data/instruments.js` | Instrumente und Drumkits |
| `src/ui/` | Canvas und Bedienung |

`audio/` und `data/` sind frei von DOM: Samples rein, Zahlen raus. `pitch.js`
und `synth.js` sind für den späteren Swift-Port gedacht, `ui/` nicht.

Details zu den Entscheidungen (warum nicht quantisiert wird, Safari-Eigenheiten,
bekannte Schwächen der Analyse) stehen in [CLAUDE.md](CLAUDE.md).
