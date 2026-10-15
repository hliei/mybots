/** Split text at paragraph boundaries, falling back to Unicode code-point runs. */
export function chunkContent(content: string, limit: number): string[] {
  if (Array.from(content).length <= limit) return [content];
  const result: string[] = [];
  let current = "";
  for (const paragraph of content.split("\n\n")) {
    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Array.from(combined).length <= limit) current = combined;
    else {
      if (current) result.push(current);
      const points = Array.from(paragraph);
      if (points.length > limit) {
        for (let index = 0; index < points.length; index += limit)
          result.push(points.slice(index, index + limit).join(""));
        current = "";
      } else current = paragraph;
    }
  }
  if (current) result.push(current);
  return result;
}
