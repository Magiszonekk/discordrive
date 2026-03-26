import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { gqlRequest } from "../lib/graphql.js";
import { registerStream, unregisterStream } from "../lib/videoStream.js";

const FILE_QUERY = `
  query File($fileId: ID!) {
    file(fileId: $fileId) {
      id name mimeType size chunkSize chunkCount encryptedFEK fekIv
    }
  }
`;

interface FileData {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  chunkSize: number;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
}

export function VideoPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => gqlRequest<{ file: FileData }>(FILE_QUERY, { fileId }),
    enabled: !!fileId,
  });

  useEffect(() => {
    if (!data?.file) return;
    let unmounted = false;
    const file = data.file;

    registerStream({
      fileId: file.id,
      mimeType: file.mimeType,
      size: file.size,
      chunkSize: file.chunkSize,
      chunkCount: file.chunkCount,
      encryptedFEK: file.encryptedFEK,
      fekIv: file.fekIv,
    })
      .then((handle) => {
        if (!unmounted) setStreamUrl(handle.url);
      })
      .catch((err) => {
        if (!unmounted) setError(String(err));
      });

    return () => {
      unmounted = true;
      unregisterStream(file.id);
    };
  }, [data?.file]);

  useEffect(() => {
    if (streamUrl && videoRef.current) {
      videoRef.current.src = streamUrl;
      videoRef.current.load();
    }
  }, [streamUrl]);

  if (isLoading) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center text-zinc-400">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      <video
        ref={videoRef}
        controls
        autoPlay
        className="max-w-full max-h-full"
      />
    </div>
  );
}
