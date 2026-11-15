/** Accepts a raw recipe or a full CyberChef URL / hash and returns the recipe string. */
export function extractRecipe(input: string): string {
    const trimmed = input.trim();
    const hashIndex = trimmed.indexOf("#");
    const candidate = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : trimmed;
    if (/(^|&)recipe=/.test(candidate)) {
        for (const part of candidate.split("&")) {
            if (part.startsWith("recipe=")) {
                const value = part.slice("recipe=".length);
                try {
                    return decodeURIComponent(value);
                } catch {
                    return value;
                }
            }
        }
    }
    return trimmed;
}
