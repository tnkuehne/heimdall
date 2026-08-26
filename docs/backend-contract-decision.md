# Entscheidungsvorlage: Sichere Verträge zwischen Extension und Backend

**Status:** Angenommen und umgesetzt

**Bewertungsstand:** 26. August 2026

**Zielgruppe:** Maintainer von Heimdall

**Geltungsbereich:** JSON-Kommunikation zwischen der GNOME-Extension und dem Rust-Backend

**Nicht Gegenstand:** Aufnahmeverfahren, Transkriptionsanbieter und Benutzeroberfläche

Dieses Dokument unterstützt eine Architekturentscheidung. Es orientiert sich an den
Leitprinzipien für verständliche Dokumente aus
[ISO 24495-1:2023](https://www.iso.org/standard/78907.html). Es erhebt keinen Anspruch auf eine
formale Konformitätsbewertung.

## Entscheidung in Kurzform

Die Empfehlung lautet:

| Frage | Empfehlung |
| --- | --- |
| Wer besitzt den Vertrag? | Explizite Protokolltypen im Rust-Backend |
| Wie wird der Vertrag austauschbar? | Schemars erzeugt JSON Schema für die Serialisierung |
| Wie entstehen TypeScript-Typen? | Lesbare Typdefinitionen werden aus demselben JSON Schema erzeugt |
| Wie entsteht die Laufzeitvalidierung? | Ajv erzeugt während des Builds eigenständige Validatoren |
| Wie ruft die Extension das Backend auf? | Konkrete, typisierte Client-Methoden statt `_runBackend<T>` |
| Wie werden Daten transportiert? | Vorerst weiter über die bestehenden Subprozesse |
| Wie wird JavaScript paketiert? | Mit tsdown und Rolldown; nicht mit esbuild |

Die empfohlene Kette ist:

```text
explizite Rust-Protokolltypen
	→ Schemars-Serialisierungsschema
	→ JSON Schema
		├── TypeScript-Typgenerator
		│	→ lesbare TypeScript-Typen
		└── Ajv Standalone
			→ ausführbare Validatoren mit strukturierten Fehlern
	→ typisierter Backend-Client
	→ tsdown/Rolldown-Bundles für GJS
```

Für die TypeScript-Typen wird zunächst `json-schema-to-typescript` mit `unknownAny: true`
empfohlen. TypeBox `Static<typeof schema>` bleibt eine brauchbare Alternative auf Type-Ebene,
falls ein zusätzlicher Typgenerator vermieden werden soll. TypeBox soll dabei nicht als
Laufzeitvalidator in GJS gelangen.

Diese Empfehlung ersetzt den früheren Plan, einen eigenen JSON-Schema-zu-Valibot-Generator zu
entwickeln. Die durchgeführten Prototypen haben gezeigt, dass Ajv Standalone die benötigte Kette
bereits ohne projektspezifische Übersetzung der JSON-Schema-Semantik bereitstellt.

## Beschluss

Folgende Punkte sind beschlossen und umgesetzt:

1. Rust ist die verbindliche Quelle des Extension-Protokolls.
2. Schemars erzeugt daraus den Serialisierungsvertrag als JSON Schema.
3. Ajv Standalone erzeugt daraus die Laufzeitvalidatoren.
4. `json-schema-to-typescript` erzeugt zunächst die TypeScript-Typen.
5. Die Extension verwendet einen konkreten, typisierten Backend-Client.
6. Unerwartete Objektfelder werden im gemeinsam ausgelieferten Protokoll abgelehnt.
7. Der bestehende Subprozess-Transport bleibt vorerst erhalten.
8. Das freie Feld `channels` bleibt bewusst `unknown`, bis die Extension dessen Struktur fachlich
   benötigt.

Die Umsetzung verwendet Schemars 1.2.2, Ajv 8.20.0, `json-schema-to-typescript` 15.0.4,
TypeScript 7.0.2 und tsdown 0.22.14. Diese Versionen sind im jeweiligen Lockfile festgehalten; die
für die Vertragssemantik maßgeblichen JavaScript-Werkzeuge sind zusätzlich exakt in
`package.json` eingetragen.

## Das sichtbare Symptom

Die Lintregeln melden unbelegte Type Assertions an den Grenzen zum Backend. Der aktuelle Code folgt
diesem Muster:

```ts
private async _runBackend<T>(args: string[]): Promise<T> {
	const stdout = await runBackend(args);
	return JSON.parse(stdout) as T;
}
```

`JSON.parse` prüft nur, ob der Text syntaktisch gültiges JSON ist. Die Assertion `as T` prüft
weder Felder noch Werte. Sie weist nur den TypeScript-Compiler an, dem Aufrufer zu vertrauen.

Außerdem verbindet `_runBackend<T>` den Befehl nicht mit seinem Ergebnistyp. Dieser Aufruf könnte
daher kompilieren:

```ts
const value = await this._runBackend<AuthStatus>(["config", "get"]);
```

Der Befehl liefert aber keine Authentifizierungsantwort.

## Woher das Problem kommt

Das Problem hat vier Ursachen.

### 1. JSON trägt keine TypeScript-Typen

JSON kennt Objekte, Arrays, Strings, Zahlen, boolesche Werte und `null`. JSON kennt weder
`BackendConfig` noch `AuthStatus`.

### 2. TypeScript-Typen existieren nicht zur Laufzeit

TypeScript entfernt Typinformationen beim Kompilieren. Ein Interface oder Type Alias kann deshalb
kein eingehendes JSON prüfen.

### 3. Befehl und Ergebnistyp sind voneinander getrennt

`_runBackend<T>` lässt den Aufrufer `T` frei wählen. Der Compiler kann nicht erkennen, welcher
Befehl welchen Wert zurückgibt.

### 4. Der Vertrag wird heute in zwei Sprachen von Hand beschrieben

Rust serialisiert die tatsächlichen Werte. TypeScript beschreibt separat, was die Extension
erwartet. Beide Beschreibungen können auseinanderlaufen.

Ein Beispiel ist `transcription_provider`:

- Rust verwendet derzeit `Option<String>`.
- TypeScript erwartet `"xai" | "deepgram" | null`.

Eine manuell bearbeitete Config kann damit für Rust strukturell gültig sein, obwohl sie die
fachliche TypeScript-Annahme verletzt.

## Was `unknown` bedeutet

`unknown` ist nicht der Defekt. Es ist an einer externen Grenze der ehrliche Ausgangstyp:

```text
Text aus einem Prozess
	→ JSON-Wert unbekannter Struktur
	→ Vertragsprüfung
	→ bekannter Protokollwert
```

Die gewünschte Regel lautet:

> Unbekannte Werte dürfen an einer I/O-Grenze entstehen. Sie müssen dort geprüft oder in einen
> Fehler umgewandelt werden.

`unknown` soll nicht tief in die Fachlogik gelangen. Der Decoder wandelt es direkt in einen
bekannten Protokolltyp oder einen verständlichen Fehler um.

Für gefangene Fehler gilt dasselbe Prinzip. Ein `catch` erhält einen unbekannten Wert. Dieser wird
an der Grenze einmal in ein `Error`-Objekt normalisiert. Danach arbeiten fachliche Methoden nur
noch mit `Error`.

## Zielzustand

Eine Backend-Antwort hat genau einen Weg in die Anwendung:

```text
Backend-Befehl
	→ stdout
	→ JSON-Syntaxprüfung
	→ Vertragsprüfung
	→ typisierter Wert
	→ Fachlogik
```

Bei einem Fehler endet die Verarbeitung an der Grenze:

```text
ungültige Antwort
	→ Fehler mit Operation, Datenpfad und Ursache
	→ keine teilweise aktualisierte Oberfläche
```

Der Zielzustand erfüllt folgende Anforderungen:

- Ein Aufrufer kann einem Befehl keinen beliebigen Ergebnistyp geben.
- Falsche JSON-Strukturen werden direkt an der Prozessgrenze abgelehnt.
- Rust- und TypeScript-Verträge können nicht unbemerkt auseinanderlaufen.
- Fehlermeldungen nennen die betroffene Backend-Operation und den Datenpfad.
- Die Extension bleibt mit GJS kompatibel.
- Das Debian-Paket enthält alle benötigten JavaScript-Module.
- Generierte Artefakte sind deterministisch, eingecheckt und in CI auf Aktualität geprüft.
- Der Transport kann unabhängig vom Vertrag geändert werden.

## Vier getrennte Architekturentscheidungen

### Vertragsquelle

Die Vertragsquelle legt fest, wo Menschen Felder, Nullbarkeit und Varianten bearbeiten.

### Laufzeitvalidierung

Die Laufzeitvalidierung prüft den tatsächlich empfangenen JavaScript-Wert. Ein generierter
TypeScript-Typ allein reicht dafür nicht aus.

### Client-API

Die Client-API verbindet eine Operation fest mit ihren Parametern, ihrem Validator und ihrem
Ergebnistyp.

### Transport

Der Transport bestimmt, ob Daten über einzelne Prozesse, einen dauerhaften Prozess oder ein
Desktop-IPC-System übertragen werden.

Eine sichere Client-API benötigt keinen neuen Transport.

## Optionen für Vertragsquelle und Validierung

### Option A: Vertrag vollständig in der Extension wiederholen

Die Extension definiert TypeScript-Typen und ausführbare Validatoren von Hand.

```text
Rust-Struktur                 TypeScript-Validator
	└──── manuell synchron halten ────┘
```

**Nutzen**

- Einfacher Buildprozess
- Wenig Werkzeug
- Gute anwendungsbezogene Fehlermeldungen möglich

**Kosten**

- Felder werden zweimal gepflegt.
- Änderungen können unbemerkt driften.
- Tests finden nur die Fälle, die sie abdecken.

**Bewertung**

Diese Option beseitigt die unsichere Assertion, aber nicht das strukturelle Drift-Risiko. Sie wird
nicht empfohlen.

### Option B: Rust erzeugt Typen; Validatoren bleiben handgeschrieben

Rust enthält explizite Protokolltypen. `ts-rs` erzeugt daraus TypeScript-Typen. Die Extension
enthält kleine handgeschriebene Validatoren, beispielsweise mit Valibot. Der Build vergleicht den
vom Validator abgeleiteten Typ mit dem generierten Rust-Typ in beide Richtungen.

```text
Rust-Protokolltyp
	→ generierter TypeScript-Typ
		↕ exakte statische Typprüfung
	handgeschriebener Validator
```

Rust-generierte Beispiele werden zusätzlich von den TypeScript-Tests validiert.

**Nutzen**

- Rust bleibt die verbindliche Quelle.
- Laufzeitvalidatoren bleiben klein und leicht lesbar.
- Valibot hat im lokalen GJS-Test funktioniert.
- Die Buildkette ist leichter als eine vollständige Generierung.

**Kosten**

- Feldnamen und Struktur erscheinen weiterhin in Rust und im Validator.
- Statische Typgleichheit erkennt nicht jede abweichende Laufzeitregel.
- Fixtures und Mutationstests bleiben notwendig.

**Bewertung**

Option B ist ein tragfähiger Rückfall, wenn die vollständige Generierung in der realen
Implementierung an einem nachgewiesenen Problem scheitert. Sie ist nicht mehr die bevorzugte
Lösung, weil Option C ohne eigenen Semantik-Generator nachgewiesen wurde.

### Option C: Rust erzeugt Typen und Laufzeitvalidatoren

Explizite Rust-Protokolltypen werden in JSON Schema übersetzt. Aus diesem einen Artefakt entstehen
TypeScript-Typen und ausführbare Validatoren.

```text
Rust-Protokolltyp
	→ Schemars
	→ JSON Schema
		├── TypeScript-Typ
		└── Laufzeitvalidator
```

#### Option C-Ajv: Standalone-Validatoren aus JSON Schema

Dies ist die Empfehlung.

```text
Rust-Protokolltyp
	→ Schemars 1.2.2 mit Contract::Serialize
	→ JSON Schema 2020-12
		├── json-schema-to-typescript 15.0.4
		│	→ TypeScript-Typen
		└── Ajv 8.20.0 im 2020-12-Modus, Standalone
			→ ESM-Validatoren
	→ typisierter Decoder
	→ tsdown
	→ GJS-Modul
```

Schemars 1.2.2 erzeugt standardmäßig JSON Schema 2020-12. Ajv muss deshalb ausdrücklich über den
2020-12-Einstiegspunkt konfiguriert werden; der normale Ajv-Standardmodus darf nicht stillschweigend
für einen anderen Dialekt verwendet werden. Ajv kompiliert die Schemas während des Builds. Die
Extension initialisiert oder kompiliert zur Laufzeit keine Schemas. Der generierte Code liefert
strukturierte Fehler und wird mit tsdown in die GJS-Einstiegsmodule gebündelt.

Schemars ergänzt für Rust-Zahlen Formathinweise wie `int32` und `double`. Diese Formate gehören
nicht zum JSON-Schema-Kern und werden von Ajv deshalb als Annotationen behandelt
(`validateFormats: false`). Die tatsächlich relevante `i32`-Semantik wird unabhängig davon durch
`integer`, `minimum: -2147483648` und `maximum: 2147483647` erzwungen und getestet.

Ajv-Standalone-Validatoren können kleine Importe aus `ajv/dist/runtime` enthalten. Sie sind deshalb
nicht in jedem Fall als einzelne Quelldatei vollständig abhängigkeitsfrei. tsdown bündelt diese
benötigten Runtime-Helfer in die ausgelieferten GJS-Module; auf dem Zielsystem wird weder Ajv
initialisiert noch `node_modules` benötigt.

TypeScript-Typ und Validator entstehen in zwei Generatorzweigen, aber beide lesen exakt dasselbe
eingecheckte JSON Schema. CI prüft, dass Schema, Typen, Validatoren und Deklarationen aktuell sind.

**Nutzen**

- Menschen pflegen die Struktur nur in Rust.
- JSON Schema bleibt als sichtbarer, standardisierter Drahtvertrag erhalten.
- Ajv implementiert die JSON-Schema-Semantik; Heimdall muss keinen eigenen Übersetzer warten.
- Validatoren werden vorab generiert und unter GJS ausgeführt.
- Strukturierte Fehler stehen an der Prozessgrenze zur Verfügung.
- Die gemessene Gzip-Größe lag nahe am Valibot-Prototyp.
- Weitere Clients können dasselbe Schema verwenden.

**Kosten**

- Mehrere Buildwerkzeuge müssen deterministisch zusammenspielen.
- Typen und Validatoren sind getrennte generierte Artefakte.
- Generierte Dateien und ihre Zuordnung benötigen Freshness- und Vertragstests.
- JSON-Schema-Dialekt und Generatorversionen müssen bewusst gepinnt werden.

**Bewertung**

Diese Variante bietet derzeit das beste Verhältnis aus einer verbindlichen Quelle,
Laufzeitsicherheit, Standardtreue, Wartbarkeit und GJS-Kompatibilität.

#### Option C-Valibot: Valibot-Code aus JSON Schema

Dieser Weg wurde geprüft und wird nicht empfohlen.

Zwei vorhandene Generatoren wurden mit dem tatsächlichen Schemars-Schema untersucht:

- `json-schema-to-valibot@0.3.1` erzeugte Code, der mit Valibot 1.4 für die reale Config nicht
  kompilierte. Unter anderem waren die Ausgabe für ein Enum mit `null` und ein `record`-Aufruf
  nicht kompatibel.
- `schema-to-library@0.3.5` erzeugte kompilierbaren Code, bildete ein boolesches Schema
  `true` jedoch auf `v.any()` ab. Das verletzt das Ziel, an der Grenze keinen `any`-Typ
  einzuführen.

Ein eigener Generator könnte diese Einzelfälle anders abbilden. Er würde Heimdall aber zum
Maintainer einer semantischen Übersetzung von JSON Schema nach Valibot machen. Schon der erste
isolierte Prototyp übersah zunächst `integer`. Das ist ein konkreter Hinweis auf das Risiko
stiller Untervalidierung.

Valibot selbst ist damit nicht als Bibliothek abgewertet. Es ist klein, verständlich und unter GJS
lauffähig. Es liefert hier nur keinen ausreichenden Mehrwert gegenüber Ajv, wenn zuvor ein eigener
oder unvollständiger Schemaübersetzer gepflegt werden müsste.

#### Option C-ATA: AOT-Validatoren

`ata-validator@1.7.2` ist konzeptionell sehr passend: Es kann JSON Schema vorab in
abhängigkeitsfreie ESM-Validatoren mit TypeScript-Typen übersetzen. Der lokale Prototyp lief unter
GJS und erzeugte besonders kleine Boolean-only-Validatoren.

Die Bibliothek ist jedoch zum Bewertungszeitpunkt sehr jung. Eine kurz zuvor veröffentlichte
Version berichtete umfangreiche Korrekturen an Codegenerierung und Buffer-Pfaden. Für einen neuen
Vertragskern ist diese Reife noch nicht ausreichend belegt.

**Bewertung**

ATA bleibt auf der Beobachtungsliste. Es ist kein sinnvoller Ausgangspunkt für die erste
Implementierung, kann Ajv später aber ersetzen, wenn Stabilität, Releasehistorie und reale Nutzung
ausreichend belegt sind.

### Option D: Eine neutrale IDL besitzt den Vertrag

Eine sprachneutrale Vertragsbeschreibung erzeugt Rust-Typen, TypeScript-Typen und Validatoren.

```text
neutrale Vertragsbeschreibung
	├── Rust
	├── TypeScript
	└── Validatoren
```

**Nutzen**

- Keine Programmiersprache besitzt den Vertrag.
- Gut für mehrere unabhängig entwickelte Clients.
- Geeignet für öffentliche Protokolle und mehrere Transporte.

**Kosten**

- Eine weitere Sprache oder Notation wird zur primären Entwicklungsoberfläche.
- Interne Rust-Typen benötigen Konvertierungen.
- Rust-spezifische Invarianten sind nicht immer direkt ausdrückbar.
- Für ein gemeinsam ausgeliefertes Backend und einen Client entsteht derzeit unverhältnismäßiger
  Aufwand.

**Bewertung**

Diese Option wird neu bewertet, wenn Heimdall ein öffentliches Protokoll, mehrere unabhängige
Clients oder eine sprachneutrale Governance benötigt. Heute wird sie nicht empfohlen.

### Option E: TypeScript besitzt den Vertrag

TypeScript definiert Typen und Validatoren. Rust-Typen werden daraus erzeugt.

**Bewertung**

Diese Richtung ist hier unnatürlich. Das Rust-Backend erzeugt und serialisiert die Daten. Seine
expliziten Protokolltypen sollen deshalb die verbindliche Quelle sein.

## Vergleich der Hauptoptionen

| Kriterium | A: doppelt von Hand | B: Typen generiert, Validatoren von Hand | C-Ajv: beides generiert | D: neutrale IDL |
| --- | --- | --- | --- | --- |
| Laufzeitprüfung | Ja | Ja | Ja | Ja |
| Schutz vor Strukturdrift | Begrenzt | Hoch | Sehr hoch | Sehr hoch |
| Von Menschen gepflegte Strukturbeschreibungen | Zwei | Eine plus geprüfter Validator | Eine | Eine |
| Eigener Semantik-Generator | Nein | Nein | Nein | Abhängig vom Stack |
| Buildkomplexität | Niedrig | Mittel | Mittel | Hoch |
| Standardisierter Vertrag | Nein | Optional | Ja | Ja |
| Eignung für weitere Clients | Begrenzt | Gut | Sehr gut | Sehr gut |
| Eignung für Heimdall heute | Nicht empfohlen | Rückfall | **Empfohlen** | Später neu bewerten |

## Warum Option C jetzt besser als Option B ist

Option B war sinnvoll, solange die vollständige Generierung einen eigenen, riskanten
JSON-Schema-zu-Valibot-Übersetzer voraussetzte. Die Ajv-Standalone-Ergebnisse ändern diese
Abwägung.

Option C-Ajv ist besser, weil:

- die Feldstruktur nur in den Rust-Protokolltypen gepflegt wird,
- ein etablierter JSON-Schema-Validator die Laufzeitsemantik übernimmt,
- Typen und Validatoren deterministisch aus demselben Schema entstehen,
- die vollständige Kette unter GJS getestet wurde,
- strukturierte Fehler verfügbar sind,
- und die komprimierte Bundlegröße im Prototyp fast der Valibot-Variante entsprach.

Option B bleibt sinnvoll, falls ein konkreter Schemafall in der echten Implementierung nicht
korrekt generiert werden kann. Ein allgemeines Misstrauen gegenüber Codegenerierung ist dagegen
kein Grund für die zusätzliche manuelle Vertragskopie.

## Wahl des TypeScript-Typgenerators

### Empfehlung: `json-schema-to-typescript`

Dieser Weg erzeugt normale, lesbare TypeScript-Interfaces. Mit `unknownAny: true` werden offene
Schemawerte soweit möglich als `unknown` statt `any` dargestellt.

Vorteile:

- Generierte Typen sind leicht zu lesen und in Reviews zu prüfen.
- Der Extension-Code benötigt keine TypeBox-Abhängigkeit.
- Typfehler bleiben für Maintainer verständlich.
- Das Ergebnis wurde mit TypeScript 7 geprüft.

### Alternative: TypeBox nur auf Type-Ebene

Wenn das JSON Schema als TypeScript-Literal generiert wird, kann
`Type.Static<typeof schema>` daraus einen statischen Typ ableiten. Type-only-Imports werden nicht
in das GJS-Bundle übernommen. Auch rekursive Testschemas wurden in der isolierten TypeScript-7-
Prüfung erfolgreich aufgelöst.

Dieser Weg spart einen Generatorzweig, bindet die Typableitung aber an TypeBox und verlangt, dass
das gesamte Schema für TypeScript als Literal sichtbar bleibt. Fehler bei komplexer Inferenz sind
weniger direkt als Fehler in einem generierten Interface.

**Bewertung**

`json-schema-to-typescript` ist zunächst die konservativere und besser prüfbare Wahl. TypeBox
`Static` ist eine echte Alternative, kein Laufzeitbestandteil und kein Grund, den TypeBox-
Validator unter GJS einzusetzen.

## Ergebnis der lokalen Prototypen

### Umfang

Die Laufzeitvarianten wurden mit fünf repräsentativen Vertragsformen geprüft:

- Recording-Status
- Extension-Config
- Authentifizierungsstatus
- Transkriptionszusammenfassung
- Capture-State-Event

Die Tests enthielten Pflichtfelder, `null`, Literale beziehungsweise Enums, Arrays, unerwartete
Felder, Ganzzahlen und das offene Feld `channels`. Die erzeugten Bundles wurden mit
`tsdown@0.22.14` gebaut und mit GJS 1.80.2 geladen.

Die folgenden Größen stammen aus isolierten lokalen Prototypen. Sie sind keine allgemeinen
Bibliotheksbenchmarks und noch kein eingecheckter, reproduzierbarer Projektbenchmark.

| Variante | Minifiziert | Gzip | GJS | Strukturierte Fehler | Ergebnis |
| --- | ---: | ---: | --- | --- | --- |
| Direkter handgeschriebener Boolean-Check | 1,93 KB | 0,71 KB | Bestanden | Nein | Klein, aber schlechte DX und manuelle Semantik |
| ATA AOT, Boolean-only | 3,08 KB | 0,74 KB | Bestanden | Nein | Technisch stark, derzeit zu jung |
| Valibot-Äquivalent | 6,65 KB | 2,15 KB | Bestanden | Ja | Gut, aber Schemaübersetzung bleibt das Problem |
| Ajv Standalone | 17,31 KB | 2,21 KB | Bestanden | Ja | **Empfohlen** |
| ATA AOT mit Fehlern | 22,80 KB | 2,25 KB | Bestanden | Ja | Technisch stark, derzeit zu jung |
| Typia, exakt und mit Integer-Tag | 14,73 KB | 3,21 KB | Bestanden | Ja | Unpassende Quelle und schwere Transformerkette |
| TypeBox Standalone | 17,11 KB | 4,62 KB | Bestanden nach externer Erzeugung | Begrenzt | Kein Vorteil gegenüber Ajv |
| Runtypes | 18,00 KB | 5,38 KB | Bestanden | Ja | Manuell gepflegtes Schema |
| Zod Mini | 18,30 KB | 5,89 KB | Bestanden | Ja | Manuell gepflegtes Schema |
| Zod | 70,91 KB | 18,78 KB | Bestanden | Ja | Für den internen Vertrag unverhältnismäßig |

Die nahezu gleiche Gzip-Größe von Valibot und Ajv ist für die Entscheidung wichtiger als die
unminifizierte Größe: Das Debian-Paket liefert komprimierbare, generierte Validatorlogik aus. Die
Entscheidung beruht trotzdem nicht allein auf Größe, sondern vor allem auf korrekter
JSON-Schema-Semantik und Wartbarkeit.

### Weitere geprüfte Grenzen

**Typia**

Typia erzeugt sehr gute Validatoren aus TypeScript-Typen. Damit würde TypeScript jedoch praktisch
zur Validatorquelle, während Rust weiterhin die Werte erzeugt. JSON-Schema-Ganzzahlen benötigen in
TypeScript zusätzliche Tags; ohne Tag akzeptierte der Prototyp `1.5`. Ohne die exakte
`Equals`-Variante wurden zusätzliche Felder akzeptiert. Die TypeScript-7-Transformerkette über
`ttsc` benötigte im Kaltlauf ungefähr zweieinhalb Minuten. Das passt nicht zur gewünschten
Rust-zuerst-Architektur und schnellen Extension-Entwicklung.

**Quicktype**

Quicktype ist ein etablierter Generator für viele Zielsprachen. Der geprüfte TypeScript-Konverter
bewahrte die JSON-Schema-Semantik für `integer` jedoch nicht vollständig und akzeptierte
`1.5`. Damit ersetzt er keinen vollständigen JSON-Schema-Validator.

**Runtime-TypeBox, ArkType und Effect**

Die geprüften Laufzeitpfade setzten Globals voraus, die GJS nicht bereitstellt. Beispiele waren
`URL` und `Blob`. Shims oder Sonderimporte würden neue Laufzeitkomplexität schaffen, ohne einen
Vorteil gegenüber dem erfolgreichen Ajv-Standalone-Weg zu liefern.

**Direkte handgeschriebene Type Guards**

Sie sind klein und benötigen keine Abhängigkeit. Sie wiederholen aber die vollständige
Vertragssemantik von Hand und liefern ohne zusätzliche Infrastruktur schwächere Fehler. Für
isolierte Spezialfälle sind sie angemessen, nicht als allgemeine Protokollstrategie.

## Das Feld `channels`

`channels: Option<serde_json::Value>` ist ein bewusster Sonderfall.

Der tatsächliche Schemars-Test mit dem Serialisierungsvertrag erzeugte dafür ein boolesches Schema
`true`. In JSON Schema bedeutet das: Jeder JSON-Wert ist erlaubt. Der ehrliche TypeScript-Typ ist
daher `unknown`, nicht ein frei verwendbares `any`.

Das ist keine Schwäche von Ajv oder des Typgenerators. Rust hat für dieses Feld derzeit selbst
keinen engeren Vertrag angegeben.

Es gibt zwei saubere Möglichkeiten:

1. `channels` bleibt bewusst offen. Der generierte TypeScript-Typ bleibt `unknown`. Die
   Extension behandelt den Wert nicht fachlich oder validiert ihn erst an der konkreten
   Verwendungsstelle.
2. Die Extension benötigt die Struktur. Dann erhält Rust dafür einen expliziten Protokolltyp, und
   Schemars erzeugt automatisch ein engeres Schema.

Eine Type Assertion oder ein manuell erfundener TypeScript-Typ ist keine dritte Lösung.

## Empfohlene Rust-Vertragsstruktur

Das Backend erhält eigene Typen für sein externes Extension-Protokoll. Interne Domainmodelle und
persistierte Config-Strukturen sind nicht automatisch öffentliche Antworten.

Mindestens folgende Protokolltypen sind erforderlich:

- Recording-Status
- Extension-Config
- Authentifizierungsstatus
- Transkriptionszusammenfassung
- Capture-State-Event

Weitere Anforderungen:

- Provider werden als geschlossenes Rust-Enum modelliert.
- Das Capture-Event ersetzt das aktuelle ad hoc erzeugte JSON-Objekt.
- Beliebige JSON-Felder werden ausdrücklich als solche markiert.
- Interne Typen werden explizit in Protokolltypen umgewandelt.
- Schemars erzeugt den Serialisierungsvertrag, weil genau dieser an die Extension gesendet wird.
- Objektstriktheit muss im erzeugten Schema sichtbar und getestet sein.

Diese Trennung verhindert, dass ein internes Refactoring unbemerkt das Extension-Protokoll ändert.

## Empfohlene Client-API

Die Extension soll keine öffentliche generische Methode mit frei wählbarem Ergebnis mehr haben:

```ts
_runBackend<T>(args): Promise<T>
```

Stattdessen erhält sie einen Backend-Client mit konkreten Operationen:

```ts
backend.getStatus()
backend.getConfig()
backend.setProvider(provider)
backend.getAuthStatus(provider)
backend.transcribe(request)
```

Jede Methode besitzt:

- feste und typisierte Argumente,
- genau einen zugeordneten Validator,
- genau einen Ergebnistyp,
- einen klaren Fehlerkontext.

Intern können alle Methoden denselben Prozess-Runner verwenden. Dieser Runner liefert nur Text. Ein
gemeinsamer Parser erzeugt daraus `unknown`; erst der zur Operation gehörende Validator erzeugt
einen fachlichen Typ.

Die generierte Ajv-Funktion erhält eine ebenfalls generierte TypeScript-Deklaration, die sie mit dem
aus demselben Schema erzeugten Ergebnistyp verbindet. Dadurch kann der Decoder nach erfolgreicher
Validierung einen Type Guard verwenden. Handgeschriebener Extension-Code benötigt dafür weder
`any` noch eine Type Assertion.

## Fehlerverhalten

Ein Vertragsfehler enthält mindestens:

- die Backend-Operation,
- die Art des Fehlers,
- den Pfad zum betroffenen Feld,
- die erwartete Regel,
- eine begrenzte und redigierte Darstellung der Antwort.

Beispiel:

```text
Ungültige Antwort auf `config get`:
`/recordings_dir` muss ein String sein; erhalten wurde eine Zahl.
```

Ajv stellt strukturierte Fehler bereit. Ein kleiner handgeschriebener Adapter übersetzt sie in ein
stabiles, anwendungsbezogenes Fehlerformat. Dieser Adapter interpretiert keine Vertragssemantik und
ist deshalb kein zweiter Validator.

Secrets und vollständige Transkriptionsantworten dürfen nicht ungeprüft in Fehlermeldungen oder
Logs gelangen.

## Transport und RPC

### Was mit „JSON über stdout“ gemeint ist

Die Extension startet heute für einen Befehl einen Backend-Prozess. Das Backend schreibt seine
JSON-Antwort in den Standardausgabestrom des Prozesses, also `stdout`. Die Extension liest diesen
Text und parst ihn.

`stdout` ist nur der Übertragungsweg. JSON ist die Nachrichtendarstellung. Der Vertrag legt fest,
welche Struktur die Nachricht haben darf. Diese drei Ebenen sind unabhängig.

### Bestehender Transport

Für jeden normalen Befehl startet die Extension das Backend und liest genau eine Antwort. Das ist
einfach, isoliert und im Terminal nachvollziehbar.

Der Capture-Monitor bleibt ein langlebiger Prozess, weil er mehrere Events liefert.

### Langlebiger stdin/stdout-Prozess

Ein dauerhafter Prozess kann Prozessstarts sparen und Requests sowie Events über eine Verbindung
übertragen. Dafür benötigt er mindestens:

- Request-IDs,
- eindeutige Nachrichtenrahmen,
- Timeouts,
- Abbruchbehandlung,
- Verhalten bei Teilnachrichten,
- Wiederverbindung nach Abstürzen.

Das kann bei hoher Aufruffrequenz sinnvoll sein. Es verbessert aber nicht automatisch die
Vertragssicherheit.

### Desktop-IPC

Ein eigenständiger Dienst lohnt sich, wenn mehrere Clients denselben Zustand verwenden oder das
Backend unabhängig von GNOME Shell leben soll. Dafür entstehen zusätzliche Aufgaben bei
Installation, Aktivierung, Lifecycle, Berechtigungen und Versionskompatibilität.

### RPC

Der RPC-Gedanke ist grundsätzlich richtig, aber RPC ist eine Schicht über dem Transport. Ein
RPC-System verbindet Methodennamen, Parameter, Ergebnisse und Fehler. Es kann über einzelne
Prozesse, einen langlebigen Stream, Sockets oder Desktop-IPC laufen.

Ein JSON-RPC- oder tRPC-ähnlicher Aufbau löst für sich allein jedoch nicht:

- die verbindliche Quelle zwischen Rust und TypeScript,
- die Laufzeitvalidierung empfangener Werte,
- die Codegenerierung zwischen den Sprachen,
- die Prozess- und Paketierungsgrenzen von GJS.

Heimdalls konkrete Backend-Client-Methoden liefern bereits den wichtigsten RPC-Nutzen auf
Anwendungsebene: Eine Operation besitzt feste Parameter und ein festes Ergebnis. Ein vollständiges
RPC-Framework wäre erst sinnvoll, wenn viele Operationen, mehrere Clients, bidirektionale Aufrufe
oder ein dauerhafter Transport hinzukommen.

Eine neutrale IDL mit generierten Rust- und TypeScript-Implementierungen wäre eine größere
Architekturentscheidung. Sie verschiebt die Vertragsquelle aus Rust und ist nicht nötig, um das
heutige Problem korrekt zu lösen.

### Empfehlung

Der bestehende Transport bleibt erhalten. Die neue Vertrags- und Client-Schicht wird so entworfen,
dass ein späterer Transportwechsel ihre fachliche API nicht verändert.

## JavaScript-Build ohne esbuild

Die Extension benötigt Bundling, weil GJS nicht wie Node.js zur Laufzeit Pakete aus
`node_modules` auflöst und weil gemeinsame lokale Module zuverlässig in das Debian-Paket gelangen
müssen.

Die Empfehlung ist `tsdown` mit Rolldown/OXC:

- Einstiegspunkte: `extension/extension.ts` und `extension/prefs.ts`
- Ausgabe: ESM für ES2022
- Plattform: neutral
- `gi://`- und `resource://`-Importe: extern
- Code-Splitting: ein stabil benanntes gemeinsames Modul für Client und Validatoren
- Ajv-Standalone-Code und lokale Module: eingebündelt
- Ergebnis: zwei Einstiegsmodule, `backend-client.js` und Metadaten

esbuild ist weder Teil der Empfehlung noch eine transitive Architekturvoraussetzung dieser Kette.

Das gemeinsame Modul vermeidet, dass die Validatorlogik in beiden Einstiegspunkten dupliziert
wird. Entwicklungsinstallation und Debian-Build installieren deshalb bewusst alle erzeugten
JavaScript-Dateien statt einer handgepflegten Zweierliste. Der Chunkname enthält keinen Hash und
ist damit für Paketierung und Diagnose stabil.

### Möglichkeit ohne Bundler

Die Vertragsvalidierung ist nicht grundsätzlich an einen Bundler gebunden. TypeScript könnte
einzelne ESM-Dateien erzeugen, und der Paketbau könnte die vollständige lokale Modulstruktur sowie
alle von Ajv Standalone benötigten Runtime-Helfer installieren.

Dieser Weg verschiebt die Komplexität in die Paketdateiliste:

- Jeder lokale Import muss im Debian-Paket vorhanden sein.
- Neue gemeinsame Module können bei der Installation vergessen werden.
- Ajv-Runtime-Helfer müssen auf für GJS auflösbare Pfade gebracht werden.
- Entwicklungsbuild und installiertes Paket können leichter voneinander abweichen.

Ein vollständig abhängigkeitsfreier AOT-Generator würde den dritten Punkt reduzieren, beseitigt
aber nicht die Paketierung der eigenen Module. Für Heimdall ist tsdown/Rolldown deshalb die
robustere Empfehlung. Ein Verzicht auf Bundling bleibt technisch möglich und ist keine
Voraussetzung für die Wahl von Rust, Schemars oder JSON Schema.

## Umgesetzte Projektstruktur

```text
backend/src/protocol.rs
	Explizite Rust-Protokolltypen

backend/src/bin/generate-contract.rs
	Deterministische Schema- und Rust-Fixture-Erzeugung

contracts/backend.schema.json
	Von Schemars erzeugter Serialisierungsvertrag

contracts/backend.fixtures.json
	Mit den echten Rust-Protokolltypen serialisierte gültige Beispiele

extension/generated/contracts.ts
	Generierte, lesbare TypeScript-Typen

extension/generated/validators.js
	Von Ajv erzeugte Standalone-Validatoren

extension/generated/validators.d.ts
	Generierte Zuordnung der Validatoren zu den generierten Typen

extension/backend-client.ts
	Konkrete Operationen und Decoding an der Prozessgrenze

scripts/generate-contracts.mjs
	Orchestrierung vorhandener Generatoren; keine eigene Schema-Semantik

tests/contracts.test.mjs und tests/contracts.gjs.mjs
	Vertrags-, Negativ-, Cross-Language- und GJS-Tests

tsdown.config.ts
	Zwei GJS-Einstiegsmodule und ein stabiler gemeinsamer Chunk
```

Der genaue Ordnername darf bei der Implementierung angepasst werden. Wichtig ist die Trennung
zwischen menschlich gepflegten Protokolltypen, generierten Artefakten, Generator-Orchestrierung und
handgeschriebener Client-Logik.

## Developer Experience

Die Architektur ist nur dann gut, wenn der normale Entwicklungsablauf einfach bleibt.

### Befehle

```text
pnpm generate:contracts
	Erzeugt Schema, TypeScript-Typen, Validatoren und Deklarationen.

pnpm contracts:check
	Erzeugt alles temporär neu und schlägt bei einer Abweichung fehl.

pnpm check
	Prüft Formatierung, Lint, Typen, Verträge und Tests.

pnpm build
	Erzeugt zwei GJS-Einstiegsmodule, den gemeinsamen Client-Chunk und die Metadaten.
```

Ein Entwickler ändert normalerweise nur den Rust-Protokolltyp und führt
`pnpm generate:contracts` aus. Generierter Code wird nicht manuell nachbearbeitet.

### Regeln für generierte Dateien

- Generierte Artefakte werden eingecheckt.
- Jede Datei trägt einen eindeutigen „nicht manuell bearbeiten“-Hinweis.
- Oxfmt und Oxlint ignorieren generierten Code.
- Ein eigenes striktes TypeScript-Projekt prüft die generierten Typdeklarationen mit
  `skipLibCheck: false`. Der Extension-Check benötigt `skipLibCheck: true`, weil die für GNOME 46
  gepinnten externen `@girs`-Deklarationen unter TypeScript 7 untereinander inkonsistent sind.
- CI prüft deterministisch, dass alle Artefakte aktuell sind.
- Ein normaler TypeScript-Check benötigt keinen vorherigen Cargo-Lauf.
- Watch-Modus oder Entwicklungsaufgabe führt die Generierung bei Änderungen am Protokoll gezielt
  aus.

### Fehlerqualität

Generatorfehler nennen den betroffenen Rust-Typ oder Schemapfad. Laufzeitfehler nennen die
Backend-Operation und den JSON-Pfad. Niemand soll generierten Ajv-Code lesen müssen, um einen
Vertragsfehler zu verstehen.

## Build- und CI-Reihenfolge

Der vollständige Check soll folgende Schritte enthalten:

1. Rust-Protokollschema deterministisch neu erzeugen.
2. TypeScript-Typen, Ajv-Validatoren und Deklarationen deterministisch neu erzeugen.
3. Alle generierten Artefakte mit dem eingecheckten Stand vergleichen.
4. Rust-Tests und Serialisierungsfixtures ausführen.
5. Gültige Rust-Fixtures mit den generierten JavaScript-Validatoren akzeptieren.
6. Gezielt beschädigte Fixtures und Mutationstests ablehnen.
7. TypeScript 7 ausführen.
8. Oxfmt prüfen.
9. Oxlint einschließlich der lokalen Anti-Slop-Regeln ohne Warnungen ausführen.
10. Die installierbaren Module mit tsdown bauen.
11. Die Standalone-Validatoren und den gebündelten Client-Chunk mit GJS laden und Validatorfälle
    ausführen.
12. Das Debian-Paket bauen und seinen Inhalt kontrollieren.

Generatorversionen, TypeScript und tsdown werden exakt gepinnt. Upgrade und neu erzeugte Artefakte
bilden eine gemeinsame, überprüfbare Änderung.

## Abnahmekriterien

Die Umsetzung ist abgeschlossen, wenn alle folgenden Aussagen stimmen:

- Es gibt kein `JSON.parse(...) as T` mehr.
- Es gibt keine öffentliche Methode `_runBackend<T>` mehr.
- Jeder Backend-Befehl ist fest mit seinem Validator verbunden.
- Syntaxfehler im JSON erzeugen einen Fehler an der Prozessgrenze.
- Falsche Wurzeltypen wie `null`, Arrays oder Strings werden abgelehnt.
- Fehlende Pflichtfelder werden abgelehnt.
- Falsche primitive Werte werden abgelehnt.
- JSON-Schema-`integer` lehnt `1.5` ab.
- Ungültige Providerwerte werden abgelehnt oder bereits in Rust verhindert.
- Unerwartete Felder werden entsprechend der beschlossenen Striktheit behandelt.
- Das offene Schema `true` wird in TypeScript als `unknown`, nicht als `any`, sichtbar.
- Handgeschriebener Extension-Code benötigt für Backend-Antworten weder `any` noch Type
  Assertions.
- Aus Rust generierte Vertragsartefakte können nicht unbemerkt veralten.
- Rust-serialisierte Vertragsbeispiele bestehen die TypeScript-Laufzeitvalidierung.
- Negativtests beweisen, dass Feld-, Typ-, Enum-, Integer- und Striktheitsverletzungen abgelehnt
  werden.
- Validatorfehler enthalten Operation und Datenpfad, ohne Secrets zu protokollieren.
- Die Standalone-Validatoren und der gebündelte Client-Chunk laufen unter GJS.
- Das Debian-Paket enthält alle benötigten Dateien.
- Formatierung, Lint, TypeScript-Prüfung, Rust-Tests und Pakettest bestehen.

## Risiken und Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
| --- | --- |
| Schemars bildet Serde-Serialisierung anders ab als erwartet | `Contract::Serialize`, Rust-Fixtures und gezielte Attributtests |
| Typgenerator und Validator interpretieren ein Schema unterschiedlich | Gemeinsame Fixtures, Negativtests und Mutationstests |
| Generierte Dateien veralten | Eingecheckte Artefakte plus `contracts:check` in CI |
| Ajv-Code ist schwer lesbar | Niemand bearbeitet ihn; Fehleradapter und Quelldatei-Zuordnung bleiben lesbar |
| Ein offenes Rust-Feld wird in TypeScript zu weit verwendet | `unknownAny: true`; fachlichen Rust-Typ ergänzen, sobald die Extension Struktur benötigt |
| Zusätzliche Felder werden versehentlich akzeptiert | Striktheit im Schema und explizite Negativtests |
| Generatorupgrade verändert Semantik | Exakte Versionen, Artefaktdiff, vollständige Vertrags- und GJS-Tests |
| Bundle funktioniert in Node, aber nicht in GJS | GJS-Smoke-Test ist verpflichtender CI-Schritt |

## Angenommener Beschluss

> Heimdall behandelt die JSON-Kommunikation zwischen Rust-Backend und GNOME-Extension als internes,
> typisiertes Protokoll. Explizite Rust-Protokolltypen sind die verbindliche Vertragsquelle.
> Schemars erzeugt daraus den JSON-Schema-Serialisierungsvertrag. Aus diesem Vertrag entstehen
> deterministisch lesbare TypeScript-Typen und Ajv-Standalone-Validatoren. Ein konkreter,
> typisierter Backend-Client validiert jede Antwort und jedes Event an der Prozessgrenze.
> Generierte Artefakte werden eingecheckt und in CI auf Aktualität, Semantik und GJS-Kompatibilität
> geprüft. Der bestehende Subprozess-Transport bleibt erhalten. Die JavaScript-Ausgabe wird mit
> tsdown und Rolldown gebündelt; esbuild ist nicht Teil der Architektur.

## Beschlusspunkte

- [x] Die empfohlene C-Ajv-Kette wird angenommen.
- [x] `json-schema-to-typescript` wird zunächst als Typgenerator verwendet.
- [x] Unerwartete Felder werden strikt abgelehnt.
- [x] Der bestehende Subprozess-Transport bleibt erhalten.
- [x] Das Capture-Monitor-Event wird ein benannter Rust-Protokolltyp.
- [x] Provider werden im Rust-Vertrag als geschlossenes Enum modelliert.
- [x] `channels` bleibt bewusst `unknown`.
- [x] Generierte Dateien werden eingecheckt und in CI deterministisch geprüft.
- [x] TypeScript 7, tsdown und alle Generatoren werden fest im Manifest und Lockfile geführt.

## Bewertete Versionen

Die isolierte Bewertung verwendete, soweit festgehalten:

| Werkzeug | Version |
| --- | --- |
| Schemars | 1.2.2 |
| Ajv | 8.20.0 |
| `json-schema-to-typescript` | 15.0.4 |
| TypeBox | 1.3.19 |
| Valibot | 1.4.2 |
| `ts-rs` | 12.0.1 |
| `json-schema-to-valibot` | 0.3.1 |
| `schema-to-library` | 0.3.5 |
| `ata-validator` | 1.7.2 |
| Zod | 4.4.3 |
| ArkType | 2.2.3 |
| TypeScript | 7.0.2 |
| tsdown | 0.22.14 |
| GJS | 1.80.2 |

Diese Tabelle beschreibt alle bewerteten Alternativen. Die für den angenommenen Weg verwendeten
Versionen sind im Projektmanifest und in den Lockfiles festgelegt. Die relevanten
Prototypergebnisse sind als reproduzierbare Node-, Rust-, Cross-Language- und GJS-Tests im
Repository enthalten.

## Quellen

- [ISO 24495-1:2023 – Plain language](https://www.iso.org/standard/78907.html)
- [ISO House Style – Plain language](https://www.iso.org/ISO-house-style.html)
- [TypeScript: Erased types](https://www.typescriptlang.org/docs/handbook/typescript-from-scratch#erased-types)
- [GJS: Imports and modules](https://gjs.guide/extensions/overview/imports-and-modules.html)
- [Schemars](https://docs.rs/schemars/latest/schemars/)
- [`ts-rs`](https://docs.rs/ts-rs/latest/ts_rs/)
- [Ajv: Standalone validation code](https://ajv.js.org/standalone.html)
- [Ajv: Strict mode](https://ajv.js.org/strict-mode.html)
- [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript)
- [TypeBox](https://github.com/sinclairzx81/typebox)
- [Valibot](https://valibot.dev/)
- [`json-schema-to-valibot`](https://github.com/hayatosc/json-schema-to-valibot)
- [`schema-to-library`](https://www.npmjs.com/package/schema-to-library)
- [ATA Validator](https://github.com/ata-core/ata-validator)
- [Typia](https://typia.io/docs/)
- [Quicktype](https://github.com/glideapps/quicktype)
- [tsdown](https://tsdown.dev/)
