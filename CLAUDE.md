# Mundwerk

Pfeifen wird ein Blasinstrument, Gesungenes auch, Mundbeats werden Drums.
Aufnehmen im Browser (bis eine Minute), anhören, als MIDI oder WAV rausgeben.
Alles lokal, nichts verlässt das Gerät.

## Aufbau

```
src/audio/pitch.js       PROFILES, NSDF-Erkennung, Aufräumstufen, noiseFloor, shapedCurve, segmentNotes
src/audio/onset.js       Bandfilter, Hüllkurven, detectHits, noiseFloorBeat, estimateBPM, gridded
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

**Zwei Profile, kein gemeinsamer Bereich.** `PROFILES.whistle` sucht zwischen
380 und 4200 Hz, `PROFILES.voice` zwischen 75 und 1300 Hz. Ein Bereich für
beides wäre für beide schlechter: Der Pfeifbereich fängt tief keine Stimme, und
ein bis 4200 Hz offenes Gesangsprofil landet dauernd auf einem Teilton. Welches
Profil gilt, entscheidet der Nutzer über den Schalter *Pfeifen / Gesang* — die
Rohaufnahme bleibt liegen, Umschalten wertet sie neu aus statt sie zu
verwerfen. Ausgelegt ist das Gesangsprofil auf gehaltene Vokale — Sprechen
liefert zwar Werte, aber bei ständig wechselnder Tonhöhe fällt das meiste
davon durch `dropRuns`, und was bleibt, sind keine Noten, die jemand haben
will.

**Das Gesangsprofil rechnet dezimiert.** Ein Suchbereich, der bis 75 Hz
runtergeht, kostet pro Frame rund das Neunfache — bei einer Minute Aufnahme
wären das gut zwanzig Sekunden Analyse (gemessen: 21 s). `decimate()` bringt das Signal vorher auf
gut 11 kHz, danach ist das Gesangsprofil sogar billiger als das Pfeifprofil
(gemessen: 1,5 s gegen 2,4 s für eine Minute). Der Frameabstand bleibt trotzdem
`HOP` Samples der **Quelle**, damit `frameRate` und alles dahinter — Zeichnung,
Kurven-Export, Notenzeiten — unverändert weiterrechnen.

**Der Tiefpass vor der Dezimierung ist kein Nebeneffekt, sondern der Grund.**
Wer die Dezimierung für einen Kompromiss zugunsten der Geschwindigkeit hält und
sie herausnimmt, macht die Erkennung *schlechter*. Gemessen über den ganzen
Gesangsbereich (`sauber` und mit Rauschen) sind dezimiert und roh auf ein
Zehntel Cent identisch, in Bias wie in Jitter. Liegt dagegen Energie oberhalb
von 5 kHz — Zischlaute, Atem, Raumrauschen, Beckenanteile —, geht die rohe
Rechnung um 20 bis 40 Cent daneben und zappelt um bis zu 35 Cent, die
dezimierte bleibt bei einem Cent. `decimate()` ist Tiefpass *plus*
Unterabtastung: Der Tiefpass macht die Genauigkeit, die Unterabtastung das
Tempo, und sie kostet nichts.

**Gesucht wird eine Oktave über `fmax`.** Nicht um sie zu melden — die Prüfung
am Ende von `detect` wirft alles über `fmax` weg —, sondern damit sie gefunden
*wird*. Reicht die Lag-Suche nur bis `fmax`, ist der oberste Ton des Profils
unerreichbar, und für alles darüber liefert der erste Peak oberhalb der
Schwelle 2T: exakt eine Oktave zu tief, und weil das Ergebnis im Bereich liegt,
wird es auch noch angenommen. Ein hoher Sopranton käme so still als Alt heraus.
`test/pitch.test.js` hält beide Richtungen fest: 98 % von `fmax` muss getroffen,
102 % muss verworfen werden.

**Das Analysefenster ist beim Gesang doppelt so lang** (46 statt 23 ms), weil
tiefe Töne lange Perioden haben. Der Preis: Was sich innerhalb eines Fensters
um mehr als einen Ton bewegt, ist für eine Autokorrelation nicht mehr
periodisch. Ein sehr schnell gezogenes Portamento verschmiert deshalb — siehe
`sing-glide.wav`, das bewusst langsamer gezogen ist als sein Pfeif-Gegenstück.

**Teiltöne werden erst korrigiert, dann verworfen.** An Ein- und
Ausschwingern einer Stimme fehlt der Grundton, und die Erkennung hängt einige
Frames lang an einem Teilton. `octaveFix` holt zurück, was ein klares Vielfaches
ist (Oktave, Quinte darüber) — für alles andere gibt es `dropOutliers`, das
solche Frames wegwirft statt zu raten. Ohne die zweite Stufe zieht `bridgeGaps`
aus einem einzigen falschen Frame eine Rampe über zweieinhalb Oktaven, und der
Grundton der Note verschiebt sich. Beide laufen in zwei Durchgängen: am Anfang
einer solchen Strecke besteht die Nachbarschaft selbst noch aus falschen
Werten.

**Im Zweifel geschlossen.** Ob eine Hi-Hat offen ist, entscheidet die
Abklingdauer im hohen Band. Steht der nächste Schlag so dicht, dass die Fahne
gar nicht zu beobachten ist, gilt sie als geschlossen. Lieber eine offene
Hi-Hat verpassen als bei jedem schnellen Muster falsche `openhat` liefern.

**Der Rauschboden wird gemessen, nicht geraten — und zwar dreimal.** `detect`
hatte immer schon eine Sperre (`RMS_GATE`, rund −44 dBFS), die aber nichts vom
Raum weiß. Über „Raum messen“ nimmt die App anderthalb Sekunden Stille auf und
bildet daraus den **Median** der Frame-Lautstärken — Median, damit eine
zugeschlagene Tür während der Messung den Wert nicht hochzieht.

Dreimal, weil drei Auswertungen in drei verschiedenen Einheiten messen: das
Pfeifprofil mit der Quellrate, das Gesangsprofil hinter seinem Tiefpass, die
Beat-Analyse in der Summe ihrer drei Bandhüllkurven. Eine Zahl in die andere
umzurechnen wäre geraten, deshalb bleibt der Messschnipsel liegen (`room.buf`,
anderthalb Sekunden Mono) und jede Auswertung bekommt ihren eigenen Boden. Beim
Umschalten springt die angezeigte Zahl deshalb — das sind verschiedene
Messungen desselben Raums, kein Anzeigefehler.

**Wogegen die Sperre hilft und wogegen nicht.** Gegen Rauschen *zwischen* den
Tönen: gemessen zieht ein Raum bei −40 dB den Grundton der ersten Note um einen
Halbton weg, mit Boden + 6 dB stimmt sie wieder. Vor allem aber entkoppelt sie
die Empfindlichkeit beim Beat vom Raum — bei 70 % findet die Erkennung in einem
Zimmer mit Lüftung 23 statt 16 Schlägen, mit Sperre wieder genau 16. Was
*während* eines Tons lauter ist als der Ton, trennt kein Pegelgate; ab etwa
−26 dB Raumpegel liefert das Gesangsprofil Teiltonfehler, die eine Schwelle
nicht adressieren kann. Der Hinweistext im Regler sagt das auch so.

**Kein Persistenzbedarf.** Aufnahmen sind flüchtig, es gibt keinen Speicher, und
es braucht auch keinen Ersatz für localStorage. Neu laden heißt neu anfangen.
Das gilt auch für den gemessenen Raum: Er hängt an der Verstärkung dieses
Mikrofons, und die ist nach einem Gerätewechsel eine andere. Lieber neu messen
als eine alte Zahl weiterschleppen.

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
im Umfang *dieser Aufnahme* gerade gepfiffen oder gesungen wird
(`centsSpan`/`normPos` in `pitch.js`). Bezugsgröße ist bewusst die Aufnahme und
nicht der Bereich des Profils — über die vier Oktaven des Pfeifprofils normiert
bliebe von einer Terz ein Zwanzigstel des Wegs übrig. Dieselbe Größe steht im Kurven-Export in der Spalte `norm`. Wer eine
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

**ScriptProcessorNode statt AudioWorklet.** Veraltet, aber überall gleich und
für eine Minute Mono völlig ausreichend — das sind knapp 12 MB im Puffer und
gut zwei Sekunden Analyse. Kein Grund zum Umbau.

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

Jede Melodie-Fixture trägt im Manifest ein `source` (`whistle` oder `voice`).
Test und Browser lesen es und analysieren mit dem passenden Profil; wer eine
neue Gesangsfixture baut, nimmt `sing()` in `scripts/make-fixtures.mjs` und
nicht `whistle()` eine Oktave tiefer — ohne Teiltonreihe testet die Fixture
nichts von dem, woran das Gesangsprofil scheitern kann. `sing()` zieht sein
Rauschen aus einem eigenen LCG, damit die älteren Fixtures byte-gleich
bleiben.

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
