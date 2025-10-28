const defaultHeaders = {
  Accept: "application/json",
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(input: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...defaultHeaders,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = (await response.json()) as { error?: string };
      if (data?.error) {
        message = data.error;
      }
    } catch (error) {
      console.warn("Failed to parse error payload", error);
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export { ApiError };
