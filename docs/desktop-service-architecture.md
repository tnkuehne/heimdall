# Architekturentscheidung: Nativer Heimdall-Desktop-Service

**Status:** Entwurf zur Bestätigung

**Stand:** 27. August 2026

**Zielgruppe:** Maintainer von Heimdall

**Geltungsbereich:** Extension, Preferences, Rust-Backend, CLI, Einstellungen und lokale IPC

Dieses Dokument beschreibt den geplanten Zielzustand. Es orientiert sich an den
Plain-Language-Prinzipien aus ISO 24495-1:2023: Die Entscheidung steht zuerst, Begriffe werden
erklärt und offene Punkte sind von beschlossenen Punkten getrennt. Es behauptet keine formale
ISO-Konformität.

## Entscheidung in Kurzform

Heimdall wird als Linux-Desktop-Service mit mehreren dünnen Frontends aufgebaut:

```text
GNOME Extension ────────┐
Preferences ────────────┼── D-Bus Session Bus ── Rust-Service ─┐
spätere Desktop-UI ─────┤                                      ├── Rust-Kernlogik
CLI start/stop/status ──┘                                      │
CLI transcribe/auth ────────────────────────────────────────────┘
                                                               ├── GSettings
                                                               └── Secret Service
```

- Der Rust-Service besitzt die gemeinsame Fachlogik und den langlebigen Betriebszustand.
- D-Bus ist die native RPC- und Ereignisschnittstelle für Desktop-Clients.
- Eine D-Bus-Introspection-XML ist die autoritative strukturelle Service-Schnittstelle.
- GSettings ist die einzige Schnittstelle für nicht geheime Einstellungen.
- API-Keys bleiben im freedesktop Secret Service.
- Die CLI bleibt für Menschen, Skripte und Agents erhalten.
- Die GNOME-Extension startet das CLI-Binary nicht mehr als improvisierten RPC-Transport.
- Extension-spezifische Aufgaben bleiben in GJS.
- Weitere Linux-Desktop-Frontends können später denselben Service verwenden.

Die JSON-/Ajv-Lösung aus PR #6 wird nicht gemergt. Sie sichert den bisherigen Transport korrekt
ab, optimiert aber eine Prozess- und JSON-Grenze, die im Zielsystem nicht mehr benötigt wird.

## Warum wir die Architektur ändern

Heute startet die Extension für fast jede Operation einen neuen CLI-Prozess und liest JSON aus
`stdout`:

```text
Extension → CLI-Unterbefehl → JSON-Text → JSON.parse(...) as T
```

Das sichtbare Problem ist die unbelegte TypeScript-Assertion. Das größere Problem ist die
Schnittstelle selbst:

- Befehl und Ergebnistyp sind nur handgeschrieben miteinander verbunden.
- Status wird alle zwei Sekunden durch einen neuen Prozess abgefragt.
- Capture-Events verwenden einen zweiten, langlebigen JSON-Prozess.
- Extension und Preferences implementieren denselben Prozess-Client getrennt.
- Mehrere Clients besitzen keine gemeinsame Instanz für Aufnahmezustand und Nebenläufigkeit.
- Config-JSON, CLI-Methoden und Frontend-Logik spiegeln dieselben Einstellungen.

D-Bus löst diese Desktop-Probleme bereits als Plattformdienst: Methoden, Antworten, Fehler,
Properties, Änderungssignale, Request-Zuordnung, Service Discovery und Aktivierung gehören zum
System. GJS kann aus Introspection-XML einen `Gio.DBusProxy` erzeugen; Rust implementiert den
Service mit `zbus`.

## Ziele

Die neue Architektur soll:

- genau eine Instanz für Aufnahmezustand und Capture-Monitoring haben;
- konkurrierende Start-/Stop-Aufrufe korrekt serialisieren;
- keine ungeprüfte JSON-Grenze zwischen Extension und Backend enthalten;
- Einstellungen ohne eigenes Config-Protokoll bereitstellen;
- GNOME Shell niemals synchron auf IPC oder lange Arbeit warten lassen;
- CLI-Automatisierung und direkten GSettings-Zugriff für Agents erhalten;
- weitere Linux-Desktop-Frontends ohne zweite Fachlogik ermöglichen;
- mit normalen Linux-Werkzeugen beobachtbar und testbar sein;
- ohne Node, WebView oder lokalen Netzwerkserver zur Laufzeit funktionieren.

## Nicht-Ziele der ersten Umsetzung

Die erste Umsetzung enthält bewusst nicht:

- allgemeines RPC über HTTP, WebSocket oder stdin/stdout;
- ein Transkriptions-Jobobjekt mit Queue, Fortschritt und Cancellation;
- Kompatibilität mit alten Extension- oder Service-Versionen;
- parallele alte und neue IPC-Schnittstellen;
- einen Node-Sidecar oder eine Tauri-/WebView-Runtime;
- ein öffentliches, desktopunabhängiges Netzwerkprotokoll;
- Unterstützung jeder Linux-Distribution im ersten Paket.

## Verantwortlichkeiten

### Rust-Service

Der Service besitzt alles, was für alle Frontends gleich ist:

- Aufnahme starten, stoppen und überwachen;
- den `ffmpeg`-Prozess besitzen;
- PipeWire beobachten und Browser-Capture-Zustand ableiten;
- Transkriptionsanbieter aufrufen;
- Post-Transcribe-Hooks ausführen;
- API-Keys über Secret Service lesen, speichern und löschen;
- GSettings lesen und fachlich prüfen;
- konkurrierende Operationen koordinieren;
- fachliche D-Bus-Fehler zurückgeben.

Der Service enthält keine GNOME-Shell-Annahmen. Die heutige Capture-Erkennung über PipeWire kann
gemeinsam bleiben, solange sie nur PipeWire-Daten verwendet. Desktop-spezifische Erkennung wird
später als Adapter ergänzt, falls ein anderer Desktop sie benötigt.

### GNOME-Extension und Preferences

GJS besitzt ausschließlich Desktop- und UI-Verhalten:

- Panel, Menüs und Preferences darstellen;
- Benachrichtigungen zeigen;
- fokussierte GNOME-Fenster auswerten;
- Ordner und Dateipositionen mit Gio öffnen;
- GSettings direkt lesen, schreiben und beobachten;
- D-Bus-Properties darstellen und Methoden asynchron aufrufen.

`open-folder` ist deshalb keine D-Bus-Methode. Die Extension öffnet das Verzeichnis selbst mit
Gio.

### CLI

Die CLI bleibt eine eigene Benutzeroberfläche für Terminal, Skripte und Agents. Sie ist kein
Transport mehr für die Extension.

- `start`, `stop` und `status` verwenden den laufenden D-Bus-Service, damit nur eine Instanz den
  Aufnahmezustand verändert.
- `transcribe` bleibt als skriptbarer Befehl erhalten und verwendet dieselbe Rust-Kernlogik.
- `auth set-stdin` bleibt erhalten, damit Secrets nicht in Prozessargumenten erscheinen.
- Nicht geheime Einstellungen werden nicht durch spiegelnde `config`-Befehle dupliziert.
- Agents verwenden `gsettings get`, `gsettings set` und `gsettings reset` direkt.
- Maschinenlesbare CLI-Ausgabe, stabile Exit-Codes und Diagnoseausgabe auf `stderr` bleiben
  Anforderungen.

Ein Headless-Modus für `start`, `stop` und `status` ohne Session-Bus gehört nicht automatisch zur
ersten Umsetzung. Er benötigt ein eigenes Zustands- und Sperrmodell und wird nur gebaut, wenn ein
konkreter Anwendungsfall vorliegt. `transcribe` darf als zustandsarme Batch-Operation weiterhin
ohne laufende Desktop-UI funktionieren.

## Einstellungen mit GSettings

Alle nicht geheimen Einstellungen wechseln aus
`~/.config/meeting-recorder/config.json` in ein installiertes GSettings-Schema.

| Einstellung | GSettings-Modell |
| --- | --- |
| Transkriptionsanbieter | String-Choice: `disabled`, `xai`, `deepgram` |
| xAI Base URL | String mit festem Default |
| Deepgram Base URL | String mit festem Default |
| Aufnahmeverzeichnis | String; leer bedeutet den aus dem Benutzerverzeichnis abgeleiteten Default |
| Post-Transcribe-Hook | String; leer bedeutet deaktiviert |
| Meeting-Erinnerung | Boolean |

GSettings garantiert Typen, Defaults, Choices und Änderungsbenachrichtigungen. Es garantiert nicht,
dass ein String eine gültige HTTP(S)-URL, ein absoluter Pfad oder eine ausführbare Datei ist.
Deshalb gelten zwei Ebenen:

1. Preferences prüfen Werte früh und zeigen direkte Rückmeldung.
2. Rust prüft jeden sicherheits- oder funktionsrelevanten Wert vor seiner Verwendung.

Ein Agent darf GSettings direkt ändern. Falls er einen fachlich ungültigen Wert setzt, muss der
Service mit einem präzisen Einstellungsfehler reagieren; er darf den Wert nicht still korrigieren
oder ungeprüft verwenden.

Das Schema wird mit dem Paket installiert und durch `glib-compile-schemas` kompiliert. Für lokale
Tests wird ein isoliertes GSettings-Backend verwendet. Es gibt keine automatische Migration für
die zwei bisherigen Nutzer; ihre Einstellungen werden beim Update kontrolliert neu gesetzt.

## D-Bus-Schnittstelle

### Bus und Aktivierung

Heimdall verwendet den Session Bus. Eine D-Bus-Service-Datei aktiviert einen systemd-User-Service
beim ersten Aufruf. Der Service bleibt in der ersten Version bis zum Ende der Benutzersitzung
aktiv. Das vermeidet verfrühte Idle- und Subscription-Logik.

Die endgültige Namensfamilie muss vor dem ersten Interface-Commit einheitlich festgelegt werden.
Die Beispiele verwenden vorläufig:

```text
Bus name:      com.timokuehne.Heimdall1
Object path:   /com/timokuehne/Heimdall1
Interface:     com.timokuehne.Heimdall1
```

Die Endung `1` bezeichnet die erste öffentliche Schnittstelle. Sie verpflichtet uns nicht zu
Abwärtskompatibilität. Client und Service werden gemeinsam ersetzt.

### Autoritative Schnittstelle

Eine eingecheckte D-Bus-Introspection-XML beschreibt Methoden, Argumente, Rückgaben, Properties
und Signale. Aus ihr entstehen:

- die zur Laufzeit von GJS verwendete Proxy-Beschreibung;
- TypeScript-Typen und eine Promise-basierte Fassade;
- lesbare API-Dokumentation.

Für die GJS-TypeScript-Fassade wurde kein ausreichend etablierter fertiger Generator gefunden.
Der geplante projektspezifische Generator bleibt deshalb bewusst klein: Er versteht nur die von
Heimdall verwendeten D-Bus-Signaturen, erzeugt keine Transportlogik und bricht bei unbekannten
Signaturen oder Annotationen ab. Seine Ausgabe wird eingecheckt, mit generierten Markierungen
versehen und in CI auf Aktualität geprüft.

`zbus_xmlgen` erzeugt derzeit Client-Proxies, aber keine fertige Rust-Serverimplementierung. Der
Rust-Service implementiert die XML deshalb mit `zbus`. Ein Integrationstest startet den echten
Service auf einem privaten Session Bus, introspektiert ihn und vergleicht seine normalisierte
Schnittstelle mit der eingecheckten XML. Drift darf den Build nicht passieren.

D-Bus-Introspection beschreibt keine abschließende Liste möglicher Fehler. Öffentliche
Fehlernamen und ihre Bedeutung werden deshalb neben der XML als Teil des Vertrags dokumentiert
und durch Rust-/GJS-Integrationstests abgedeckt. Wir behaupten nicht, dass XML diese Lücke allein
schließt.

### Erste fachliche Oberfläche

Die konkrete XML entsteht erst nach einem kleinen Integrationsprototyp. Sie soll ungefähr diese
Fähigkeiten enthalten:

| Art | Fähigkeit |
| --- | --- |
| Property | Aufnahme läuft |
| Property | Browser-Audio-Capture aktiv |
| Property | Browser-Video-Capture aktiv |
| Methode | Aufnahme starten |
| Methode | Aufnahme stoppen und gespeicherten Pfad liefern |
| Methode | Datei transkribieren und Transcript-Pfad liefern |
| Methode | API-Key-Status eines Providers abfragen |
| Methode | API-Key aus einem Unix-Dateideskriptor speichern |
| Methode | API-Key eines Providers löschen |
| Signal | automatische Transkription abgeschlossen oder fehlgeschlagen |

Es gibt keine Config-Methoden, kein `OpenFolder`, kein freies `a{sv}`-Objekt und keine JSON-Strings
in der D-Bus-API. Capture-Zustand verwendet normale read-only Properties und das standardisierte
`PropertiesChanged`-Signal.

### Laufzeitprüfung

D-Bus ersetzt Ajv an dieser Grenze, aber nicht jede Validierung:

- D-Bus, Gio und `zbus` prüfen die strukturellen GVariant-Signaturen.
- Rust prüft fachliche Eingaben, Zustandsübergänge, Pfade, URLs und Provider.
- GJS behandelt unbekannte Fehlernamen und zukünftige Enumwerte kontrolliert.
- TypeScript-Typen verbessern die Entwicklungsoberfläche, sind aber nicht die Wire-Prüfung.

Damit entfällt diese Kette:

```text
JSON.parse → unknown → Ajv → TypeScript-Typ
```

Die neue Kette ist:

```text
D-Bus-Nachricht → GVariant-Signatur → Gio/zbus → fachliche Prüfung → Anwendungswert
```

## Zustand und Nebenläufigkeit

Ein einzelner Koordinator im Rust-Service besitzt den veränderlichen Aufnahmezustand. D-Bus-
Handler verändern ihn nicht unabhängig, sondern senden Befehle an diesen Koordinator. Dadurch
werden gleichzeitige `start`-, `stop`- und `status`-Aufrufe deterministisch behandelt.

Langsame oder blockierende Arbeit darf weder den D-Bus-Dispatcher noch den Zustandskoordinator
blockieren:

- Transkription läuft in einer eigenen asynchronen oder dedizierten Blocking-Task.
- Warten auf Kindprozesse und Stop-Timeouts blockiert keinen Executor-Thread.
- Der Koordinator verarbeitet währenddessen weiterhin Statusanfragen.
- GNOME Shell verwendet ausschließlich asynchrone D-Bus-Aufrufe.

Ein explizit angeforderter `Transcribe`-Aufruf bleibt zunächst ein normaler langer
Methodenaufruf. Der Client deaktiviert dafür den künstlichen Standard-Timeout. Ein Job-System wird
erst eingeführt, wenn Fortschritt, Cancellation, Queues oder Wiederaufnahme tatsächlich benötigt
werden.

### Verhalten nach einem Service-Crash

Hier ist noch eine Bestätigung erforderlich. Die empfohlene erste Variante lautet:

- `ffmpeg` gehört zum systemd-User-Service und wird nicht absichtlich verwaist.
- Ein Service-Crash beendet die laufende Aufnahme kontrolliert.
- Die `.part.mp3` bleibt erhalten und wird beim nächsten Start als abgebrochene Aufnahme erkannt.
- Der Service meldet diesen Zustand verständlich, statt eine fremde PID nur anhand einer
  Zustandsdatei zu übernehmen.

Ein `ffmpeg`, das den Service überlebt und später wieder übernommen wird, ist möglich, benötigt
aber eine robuste Prozessidentität, Race-Schutz und Recovery-Tests. Diese Komplexität wird nur
gewählt, wenn der Produktnutzen das zusätzliche Fehlerrisiko rechtfertigt.

## Automatische Transkription

Heute startet nur die GNOME-Extension nach dem Stoppen die automatische Transkription. Das würde
jedes neue Frontend zwingen, denselben Workflow nachzubauen.

Die empfohlene Zielregel lautet deshalb:

```text
Aufnahme stoppen
    → Datei sicher finalisieren
    → StopRecording antwortet sofort mit dem Dateipfad
    → bei aktiviertem Provider startet der Service die Transkription
    → Service signalisiert Erfolg oder Fehler
```

Das ist kein allgemeines Job-System. Es ist ein gemeinsamer fachlicher Workflow. Ein expliziter
`Transcribe`-Aufruf bleibt zusätzlich für CLI und manuelle Aktionen verfügbar.

## Secrets

API-Keys bleiben im freedesktop Secret Service und niemals in GSettings, JSON-Dateien,
Kommandozeilenargumenten oder Logs.

Preferences übergibt einen neuen Key bevorzugt über einen Unix-Dateideskriptor. Gio und D-Bus
unterstützen FD-Listen; ein GJS-Prototyp muss den vollständigen Weg bis `zbus` beweisen, bevor das
Interface festgeschrieben wird. Der FD vermeidet, dass der Key als normaler String im
D-Bus-Payload erscheint.

Der Session Bus ist trotzdem keine Sicherheitsgrenze zwischen Prozessen desselben Benutzers. FD-
Übergabe reduziert unnötige Secret-Kopien und versehentliches Logging, schützt aber keinen bereits
kompromittierten Benutzeraccount.

## Weitere Linux-Desktops

D-Bus, PipeWire, systemd-User-Services, GSettings und Secret Service sind nicht an GNOME Shell
gebunden. Ein späteres Omarchy-/Hyprland-Frontend kann daher denselben Rust-Service verwenden.

Ein neues Frontend implementiert nur:

- seine native Oberfläche;
- Benachrichtigungen;
- Ordner-/Dateiaktionen;
- Fenster-, Panel- oder Shortcut-Integration;
- gegebenenfalls einen desktop-spezifischen Erkennungsadapter.

Es implementiert Aufnahme, Transkription, Secrets oder gemeinsamen Zustand nicht erneut.

Die tatsächliche Distribution muss die benötigten Desktop-Dienste bereitstellen. Besonders ein
Secret-Service-Provider und ein GSettings-Backend dürfen auf einem minimalen Hyprland-System nicht
stillschweigend vorausgesetzt werden; Paketierung und Diagnose müssen diese Abhängigkeiten sichtbar
machen.

## JavaScript-Build

Der D-Bus-Client benötigt keine npm-Laufzeitbibliothek. Deshalb bleibt `tsc` zunächst der
bevorzugte Buildweg. Alle erzeugten lokalen JavaScript-Module werden vollständig installiert;
Paketierung darf nicht erneut nur `extension.js` und `prefs.js` hardcodieren.

Ein Bundler wird nur eingeführt, wenn eine konkrete Runtime-Abhängigkeit oder ein nachgewiesenes
GJS-Paketierungsproblem ihn erforderlich macht. Falls das geschieht, bleibt tsdown/Rolldown der
bevorzugte Weg. esbuild ist nicht Teil der Architektur.

## Umsetzung in risikoorientierter Reihenfolge

1. PR #6 ohne Merge schließen und seinen Branch erhalten.
2. Einen neuen Branch vom aktuellen `main` erstellen.
3. Öffentliche Namen für Produkt, Bus, Interface, Object Path und GSettings vereinheitlichen.
4. Einen kleinen D-Bus-Prototyp bauen:
   - eine Methode;
   - eine Property mit `PropertiesChanged`;
   - einen fachlichen Fehler;
   - einen API-Key über Unix-FD;
   - Aktivierung durch den installierten systemd-User-Service;
   - asynchroner Aufruf aus GJS.
5. Erst bei bestandenem Prototyp die D-Bus-XML festschreiben und Bindings erzeugen.
6. Rust-Fachlogik aus dem heutigen CLI-Dispatcher in wiederverwendbare Module verschieben.
7. GSettings-Schema und fachliche Settings-Prüfung einführen; Config-JSON entfernen.
8. Aufnahme-Koordinator und PipeWire-Monitor in den Service verschieben.
9. GNOME-Extension und Preferences auf GSettings, Gio und D-Bus umstellen.
10. Zustandsbehaftete CLI-Befehle an denselben Service anbinden.
11. Paketierung, Development-Install und CI ergänzen.
12. Erst nach End-to-End-Tests den alten Subprozess-/JSON-Pfad entfernen.

Unabhängig wertvolle Änderungen aus PR #6 werden neu und gezielt umgesetzt: PR-Validierung,
Rustfmt, Clippy, Rust-Tests, sichere Secret-Eingabe und passende CLI-Integrationstests. Die
JSON-Schema-/Ajv-Kette und ihre tsdown-Abhängigkeit werden nicht übernommen.

## Qualitäts- und Abnahmekriterien

Die Migration ist abgeschlossen, wenn:

- Extension und Preferences keinen CLI-Unterprozess für Backend-Aufrufe starten;
- es kein `JSON.parse(...) as T` an der Desktop-Service-Grenze gibt;
- D-Bus-Properties Status-Polling und Capture-NDJSON ersetzen;
- gleichzeitige Start-/Stop-Aufrufe in Integrationstests deterministisch bleiben;
- GSettings alle nicht geheimen Einstellungen besitzt und Config-JSON entfernt ist;
- ungültige direkt gesetzte GSettings-Werte verständliche Fehler erzeugen;
- API-Keys nur über Secret Service und einen geprüften Eingabekanal laufen;
- der echte Rust-Service auf einem privaten Session Bus gegen die XML getestet wird;
- die GJS-Bindings deterministisch erzeugt und in CI auf Aktualität geprüft werden;
- GJS-Integrationstests Methoden, Properties, Änderungen, Fehler und Service-Restart abdecken;
- der GNOME-Main-Thread nicht durch synchrone IPC oder Backend-Arbeit blockiert wird;
- CLI und Extension denselben Aufnahmezustand sehen;
- das Debian-Paket Binary, Extension, GSettings-Schema, D-Bus-Service-Datei, systemd-User-Unit und
  alle JavaScript-Module enthält;
- CI bei Pull Requests mit Leserechten Formatierung, Oxlint, TypeScript, Rustfmt, Clippy, Tests und
  Paketbau ausführt;
- der bestehende Workflow-Name `Release` unverändert bleibt;
- das installierte System mit `gdbus`, `busctl`, `journalctl` und D-Spy diagnostizierbar ist.

## Noch zu bestätigen

Vor der vollständigen Implementierung müssen diese Punkte ausdrücklich bestätigt oder durch den
Prototyp entschieden werden:

- [ ] Einheitliche öffentliche Namensfamilie: Heimdall oder Meeting Recorder
- [ ] `ffmpeg` endet bei Service-Crash; `.part.mp3` bleibt zur Recovery erhalten
- [ ] Kein Headless-Fallback für zustandsbehaftete CLI-Befehle in Version 1
- [ ] Automatische Transkription nach `stop` gehört in den Rust-Service
- [ ] GJS→D-Bus→zbus-Übergabe eines API-Keys per Unix-FD funktioniert zuverlässig

Alle übrigen Kernentscheidungen dieses Dokuments entsprechen dem zuletzt besprochenen Zielbild.

## Quellen

- [D-Bus API Design Guidelines](https://dbus.freedesktop.org/doc/dbus-api-design.html)
- [D-Bus Specification](https://dbus.freedesktop.org/doc/dbus-specification.html)
- [GJS: D-Bus mit Gio](https://gjs.guide/guides/gio/dbus.html)
- [Gio.Settings](https://docs.gtk.org/gio/class.Settings.html)
- [zbus](https://docs.rs/zbus/latest/zbus/)
- [zbus_xmlgen](https://docs.rs/crate/zbus_xmlgen/latest)
- [ISO 24495-1:2023](https://www.iso.org/standard/78907.html)
