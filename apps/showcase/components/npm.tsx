import { Package } from "lucide-react";
import { Button } from "./ui/button";
import Link from "next/link";

export default function Npm() {
  return (
    <div className="fixed top-4 left-4 max-md:top-2 max-md:left-2">
        <Link href="https://www.npmjs.com/package/@cmdoss/memwal-sdk">
      <Button className="rounded-3xl text-lg bg-white text-black font-bold shadow-xs hover:bg-white/70 max-md:text-sm max-md:p-2">
          <Package />
          Try our SDK
      </Button>
      </Link>
    </div>
  )
}