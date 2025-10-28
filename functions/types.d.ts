interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type PagesFunction<Env = unknown> = (context: {
  env: Env;
  params: Record<string, string | string[]>;
  request: Request;
}) => Response | Promise<Response>;
