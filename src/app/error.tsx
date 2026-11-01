"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <section className="card"><h1>We could not load your record</h1><p>Your collection has not been changed by this page failing to load. Please try again shortly.</p><button onClick={reset}>Try again</button></section>;
}
