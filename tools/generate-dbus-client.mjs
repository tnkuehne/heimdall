import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { XMLParser } from "fast-xml-parser";
import { format } from "oxfmt";

const root = resolve(import.meta.dirname, "..");
const xmlPath = resolve(root, "data/com.timokuehne.MeetingRecorder1.xml");
const outputPath = resolve(root, "extension/dbus-client.ts");
const check = process.argv.includes("--check");

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	isArray: (name) => ["interface", "method", "arg", "property", "signal"].includes(name),
});

const xml = await readFile(xmlPath, "utf8");
const document = parser.parse(xml);
const interfaces = document.node?.interface;
if (!Array.isArray(interfaces)) throw new Error("D-Bus XML has no interfaces");

const service = interfaces.find(
	(candidate) => candidate.name === "com.timokuehne.MeetingRecorder1",
);
if (!service) throw new Error("D-Bus XML has no MeetingRecorder1 interface");

const methods = service.method ?? [];
const properties = service.property ?? [];
const signals = service.signal ?? [];
const supportedTypes = new Set(["b", "h", "s"]);

for (const member of [...methods, ...signals]) {
	if (!member.name) throw new Error("D-Bus interface has an unnamed member");
	for (const argument of member.arg ?? []) {
		if (!supportedTypes.has(argument.type))
			throw new Error(`${member.name} uses unsupported D-Bus type ${argument.type}`);
		if (!argument.name) throw new Error(`${member.name} has an unnamed argument`);
	}
}
for (const method of methods) {
	for (const argument of method.arg ?? []) {
		if (argument.direction !== "in" && argument.direction !== "out")
			throw new Error(`${method.name}.${argument.name} has no valid direction`);
	}
}
for (const signal of signals) {
	for (const argument of signal.arg ?? []) {
		if (argument.direction !== undefined)
			throw new Error(`${signal.name}.${argument.name} must not declare a direction`);
		if (argument.type === "h")
			throw new Error(`${signal.name} has an unsupported file descriptor argument`);
	}
}
for (const property of properties) {
	if (!property.name) throw new Error("D-Bus interface has an unnamed property");
	if (property.type !== "b" && property.type !== "s")
		throw new Error(`${property.name} uses unsupported D-Bus type ${property.type}`);
	if (property.access !== "read") throw new Error(`${property.name} is not a read-only property`);
}

const inputArguments = (method) =>
	(method.arg ?? []).filter((argument) => argument.direction === "in");
const outputArguments = (method) =>
	(method.arg ?? []).filter((argument) => argument.direction === "out");
for (const method of methods) {
	for (const argument of outputArguments(method)) {
		if (argument.type === "h")
			throw new Error(`${method.name} has an unsupported file descriptor output`);
	}
}
const camel = (name) => {
	const [first, ...rest] = name.split("_");
	return first[0].toLowerCase() + first.slice(1) + rest.map(pascal).join("");
};
const pascal = (name) =>
	name
		.split("_")
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join("");
const tsType = (signature) => {
	switch (signature) {
		case "b":
			return "boolean";
		case "h":
			return "number";
		case "s":
			return "string";
		default:
			throw new Error(`Unsupported D-Bus type ${signature}`);
	}
};
const reader = (argument, index, tuple = "reply") =>
	`read${argument.type === "b" ? "Boolean" : argument.type === "s" ? "String" : "Handle"}(${tuple}, ${index})`;

const resultTypes = methods
	.map((method) => {
		const outputs = outputArguments(method);
		if (outputs.length < 2) return "";
		return `export type ${method.name}Result = {\n${outputs
			.map((argument) => `\t${camel(argument.name)}: ${tsType(argument.type)};`)
			.join("\n")}\n};`;
	})
	.filter(Boolean)
	.join("\n\n");

const methodSources = methods
	.map((method) => {
		const inputs = inputArguments(method);
		const outputs = outputArguments(method);
		const hasFd = inputs.some((argument) => argument.type === "h");
		if (hasFd && inputs.filter((argument) => argument.type === "h").length !== 1)
			throw new Error(`${method.name} must have exactly one file descriptor argument`);

		const publicInputs = inputs.map((argument) => {
			if (argument.type === "h") return `${camel(argument.name)}: string`;
			return `${camel(argument.name)}: ${tsType(argument.type)}`;
		});
		publicInputs.push("cancellable: Gio.Cancellable | null = null");

		const returnType =
			outputs.length === 0
				? "void"
				: outputs.length === 1
					? tsType(outputs[0].type)
					: `${method.name}Result`;
		const inputSignature = inputs.map((argument) => argument.type).join("");
		const outputSignature = outputs.map((argument) => argument.type).join("");

		let call;
		if (hasFd) {
			const fdArgument = inputs.find((argument) => argument.type === "h");
			const nonFdInputs = inputs.filter((argument) => argument.type !== "h");
			const values = inputs
				.map((argument) => (argument.type === "h" ? "handle" : camel(argument.name)))
				.join(", ");
			call = `const reply = await this._callWithSecret(\n\t\t\t"${method.name}",\n\t\t\t(handle) => new GLib.Variant("(${inputSignature})", [${values}]),\n\t\t\t${camel(fdArgument.name)},\n\t\t\tcancellable,\n\t\t);`;
			if (nonFdInputs.length === 0)
				throw new Error(`${method.name} must identify the secret with a regular argument`);
		} else {
			const values = inputs.map((argument) => camel(argument.name)).join(", ");
			call = `const reply = await this._call(\n\t\t\t"${method.name}",\n\t\t\tnew GLib.Variant("(${inputSignature})", [${values}]),\n\t\t\t${method.name === "Transcribe" ? "GLib.MAXINT32" : "-1"},\n\t\t\tcancellable,\n\t\t);`;
		}

		let result;
		if (outputs.length === 0) result = "return;";
		else if (outputs.length === 1) result = `return ${reader(outputs[0], 0)};`;
		else
			result = `return {\n${outputs
				.map(
					(argument, index) =>
						`\t\t\t${camel(argument.name)}: ${reader(argument, index)},`,
				)
				.join("\n")}\n\t\t};`;

		return `async ${camel(method.name)}(\n\t\t${publicInputs.join(",\n\t\t")},\n\t): Promise<${returnType}> {\n\t\t${call}\n\t\texpectTuple(reply, "(${outputSignature})", "${method.name}");\n\t\t${result}\n\t}`;
	})
	.join("\n\n\t");

const propertySources = properties
	.map(
		(property) =>
			`get ${camel(property.name)}(): ${tsType(property.type)} {\n\t\treturn readCached${property.type === "b" ? "Boolean" : "String"}(this._proxy, "${property.name}");\n\t}`,
	)
	.join("\n\n\t");

const signalSources = signals
	.map((signal) => {
		const args = signal.arg ?? [];
		const signature = args.map((argument) => argument.type).join("");
		const handlerArgs = args
			.map((argument) => `${camel(argument.name)}: ${tsType(argument.type)}`)
			.join(", ");
		const values = args
			.map((argument, index) => reader(argument, index, "parameters"))
			.join(", ");
		return `connect${signal.name}(handler: (${handlerArgs}) => void): number {\n\t\treturn this._proxy.connect(\n\t\t\t"g-signal",\n\t\t\t(_proxy, _sender, signalName, parameters) => {\n\t\t\t\tif (signalName !== "${signal.name}") return;\n\n\t\t\t\texpectTuple(parameters, "(${signature})", "${signal.name}");\n\t\t\t\thandler(${values});\n\t\t\t},\n\t\t);\n\t}`;
	})
	.join("\n\n\t");

const unformatted = `// Generated by tools/generate-dbus-client.mjs from data/com.timokuehne.MeetingRecorder1.xml.
// Do not edit this file by hand.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

export const BUS_NAME = ${JSON.stringify(service.name)};
export const OBJECT_PATH = ${JSON.stringify(document.node.name)};

${resultTypes}

export class MeetingRecorderClient {
	private constructor(private readonly _proxy: Gio.DBusProxy) {}

	static connect(cancellable: Gio.Cancellable | null = null): Promise<MeetingRecorderClient> {
		return new Promise((resolve, reject) => {
			Gio.DBusProxy.new_for_bus(
				Gio.BusType.SESSION,
				Gio.DBusProxyFlags.NONE,
				null,
				BUS_NAME,
				OBJECT_PATH,
				BUS_NAME,
				cancellable,
				(_source, result) => {
					try {
						resolve(new MeetingRecorderClient(Gio.DBusProxy.new_for_bus_finish(result)));
					} catch (error) {
						reject(error);
					}
				},
			);
		});
	}

	get available(): boolean {
		return this._proxy.get_name_owner() !== null;
	}

	${propertySources}

	connectPropertiesChanged(handler: () => void): number {
		return this._proxy.connect("g-properties-changed", handler);
	}

	connectAvailabilityChanged(handler: () => void): number {
		return this._proxy.connect("notify::g-name-owner", handler);
	}

	${signalSources}

	disconnect(signalId: number): void {
		this._proxy.disconnect(signalId);
	}

	${methodSources}

	private _call(
		method: string,
		parameters: GLib.Variant,
		timeout: number,
		cancellable: Gio.Cancellable | null,
	): Promise<GLib.Variant> {
		return new Promise((resolve, reject) => {
			this._proxy.call(
				method,
				parameters,
				Gio.DBusCallFlags.NONE,
				timeout,
				cancellable,
				(_source, result) => {
					try {
						resolve(this._proxy.call_finish(result));
					} catch (error) {
						reject(error);
					}
				},
			);
		});
	}

	private async _callWithSecret(
		method: string,
		parametersForHandle: (handle: number) => GLib.Variant,
		secret: string,
		cancellable: Gio.Cancellable | null,
	): Promise<GLib.Variant> {
		const [reader, writer] = createSocketPair();
		const descriptorList = Gio.UnixFDList.new();
		const handle = descriptorList.append(reader.get_fd());
		reader.close();

		const call = this._callWithFileDescriptors(
			method,
			parametersForHandle(handle),
			descriptorList,
			cancellable,
		);
		let writeError: Error | null = null;
		try {
			writeSecret(writer, secret, cancellable);
		} catch (error) {
			writeError = error instanceof Error ? error : new Error(String(error));
		}
		const reply = await call;
		if (writeError) throw writeError;
		return reply;
	}

	private _callWithFileDescriptors(
		method: string,
		parameters: GLib.Variant,
		descriptors: Gio.UnixFDList,
		cancellable: Gio.Cancellable | null,
	): Promise<GLib.Variant> {
		return new Promise((resolve, reject) => {
			this._proxy.call_with_unix_fd_list(
				method,
				parameters,
				Gio.DBusCallFlags.NONE,
				-1,
				descriptors,
				cancellable,
				(_source, result) => {
					try {
						const [reply] = this._proxy.call_with_unix_fd_list_finish(result);
						resolve(reply);
					} catch (error) {
						reject(error);
					}
				},
			);
		});
	}
}

function createSocketPair(): [Gio.Socket, Gio.Socket] {
	if (!Gio.UnixSocketAddress.abstract_names_supported())
		throw new Error("Unix abstract sockets are unavailable");

	const name = Array.from(new TextEncoder().encode(\`heimdall-\${GLib.uuid_string_random()}\`));
	const address = Gio.UnixSocketAddress.new_abstract(name);
	const listener = Gio.Socket.new(
		Gio.SocketFamily.UNIX,
		Gio.SocketType.STREAM,
		Gio.SocketProtocol.DEFAULT,
	);
	let writer: Gio.Socket | null = null;
	try {
		listener.bind(address, false);
		listener.listen();
		writer = Gio.Socket.new(
			Gio.SocketFamily.UNIX,
			Gio.SocketType.STREAM,
			Gio.SocketProtocol.DEFAULT,
		);
		writer.connect(address, null);
		return [listener.accept(null), writer];
	} catch (error) {
		writer?.close();
		throw error;
	} finally {
		listener.close();
	}
}

function writeSecret(
	writer: Gio.Socket,
	value: string,
	cancellable: Gio.Cancellable | null,
): void {
	const bytes = new TextEncoder().encode(value);
	if (bytes.length > 64 * 1024) throw new Error("API key exceeds the 64 KiB limit");

	try {
		let offset = 0;
		while (offset < bytes.length) {
			const written = writer.send(bytes.subarray(offset), cancellable);
			if (written <= 0) throw new Error("Failed to write API key to Unix socket");
			offset += written;
		}
	} finally {
		writer.close();
	}
}

function expectTuple(value: GLib.Variant, signature: string, member: string): void {
	if (value.get_type_string() !== signature)
		throw new Error(\`Invalid D-Bus response for \${member}: expected \${signature}\`);
}

function child(value: GLib.Variant, index: number): GLib.Variant {
	return value.get_child_value(index);
}

function readBoolean(value: GLib.Variant, index: number): boolean {
	return child(value, index).get_boolean();
}

function readString(value: GLib.Variant, index: number): string {
	return child(value, index).get_string()[0];
}

function readCachedBoolean(proxy: Gio.DBusProxy, property: string): boolean {
	const value = proxy.get_cached_property(property);
	if (!value || value.get_type_string() !== "b")
		throw new Error(\`D-Bus property \${property} is unavailable\`);
	return value.get_boolean();
}

function readCachedString(proxy: Gio.DBusProxy, property: string): string {
	const value = proxy.get_cached_property(property);
	if (!value || value.get_type_string() !== "s")
		throw new Error(\`D-Bus property \${property} is unavailable\`);
	return value.get_string()[0];
}
`;

const formatted = await format(outputPath, unformatted, { tabWidth: 4, useTabs: true });
if (formatted.errors.length > 0)
	throw new Error(`Failed to format generated D-Bus client: ${formatted.errors[0].message}`);
const generated = formatted.code;

if (check) {
	let current;
	try {
		current = await readFile(outputPath, "utf8");
	} catch {
		throw new Error("Generated D-Bus client is missing; run pnpm dbus:generate");
	}
	if (current !== generated)
		throw new Error("Generated D-Bus client is stale; run pnpm dbus:generate");
} else {
	await writeFile(outputPath, generated);
}
