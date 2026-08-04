const SENSITIVE_PARAMETER_PATTERN =
	/^(?:access[_-]?token|auth[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|api[_-]?key|authorization|ct0)$/iu;

function redactSensitiveUrl(value: string) {
	try {
		const url = new URL(value);
		if (url.username) url.username = "[REDACTED]";
		if (url.password) url.password = "[REDACTED]";
		for (const key of url.searchParams.keys()) {
			if (SENSITIVE_PARAMETER_PATTERN.test(key)) {
				url.searchParams.set(key, "[REDACTED]");
			}
		}
		return url.toString();
	} catch {
		return value;
	}
}

export function redactSensitiveText(value: string) {
	return value
		.replace(/https?:\/\/[^\s<>"']+/giu, redactSensitiveUrl)
		.replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
		.replace(
			/(["']?)\b(access[_-]?token|auth[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|api[_-]?key|authorization|ct0)\b\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
			"$1$2$1$3[REDACTED]",
		);
}

export function sensitiveErrorMessage(error: unknown) {
	return redactSensitiveText(
		error instanceof Error ? error.message : String(error),
	);
}
