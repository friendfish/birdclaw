export interface PlaygroundResultBase {
	markdown: string;
	parseStatus: "structured" | "fallback";
	generatedAt: string;
}

export interface PlaygroundStreamHandlers<T> {
	onDelta?: (delta: string) => void;
	onEvent?: (event: PlaygroundStreamEvent<T>) => void;
}

export type PlaygroundStreamEvent<T> =
	| { type: "delta"; delta: string }
	| { type: "done"; result: T }
	| { type: "error"; error: string };
