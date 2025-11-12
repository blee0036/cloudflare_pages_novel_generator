interface Env {
  ASSETS: Fetcher;
}

type ChapterEntry = [string, string, number, number, number];

interface ChaptersFile {
  book: {
    id: string;
    title: string;
    assets: string[];
  };
  chapters: ChapterEntry[];
}

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
} as const;

export const onRequestGet: PagesFunction<Env> = async ({ env, params, request }) => {
  const bookId = params.bookId?.toString();
  if (!bookId) {
    return new Response(JSON.stringify({ error: "Missing book id" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  try {
    const chaptersUrl = new URL(`/data/${bookId}_chapters.json`, request.url);
    const chaptersResponse = await env.ASSETS.fetch(chaptersUrl.toString());
    if (!chaptersResponse.ok) {
      return new Response(JSON.stringify({ error: "Book not found" }), {
        status: chaptersResponse.status,
        headers: jsonHeaders,
      });
    }

    const chaptersData = (await chaptersResponse.json()) as ChaptersFile;
    const assetPaths = chaptersData.book.assets ?? [];

    if (assetPaths.length === 0) {
      return new Response(JSON.stringify({ error: "No content available" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    const { readable, writable } = new TransformStream();

    (async () => {
      try {
        for (let index = 0; index < assetPaths.length; index += 1) {
          const assetPath = assetPaths[index];
          const assetUrl = new URL(assetPath, request.url);
          const assetResponse = await env.ASSETS.fetch(assetUrl.toString());
          if (!assetResponse.ok || !assetResponse.body) {
            throw new Error(`Failed to fetch asset chunk: ${assetPath}`);
          }
          await assetResponse.body.pipeTo(writable, { preventClose: index !== assetPaths.length - 1 });
        }
      } catch (streamError) {
        await writable.abort(streamError as Error);
      }
    })().catch((streamError) => {
      console.error(streamError);
    });

    const asciiName = `${bookId}.txt`;
    const utf8Name = `${chaptersData.book.title}.txt`;

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(asciiName)}"; filename*=UTF-8''${encodeURIComponent(
          utf8Name,
        )}`,
        "Cache-Control": "no-cache, no-store, must-revalidate", // 禁止缓存，避免 304
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "Download failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
};
