import { Separator } from "./ui/separator";

export function MarketingBorder() {
    return (
        <>
            <Separator className="absolute z-10 left-0 top-8 border-border" />
            <Separator className="absolute z-10 left-0 bottom-8 border-border" />
            <Separator className="absolute z-10 top-0 left-8 border-border" orientation="vertical" />
            <Separator className="absolute z-10 top-0 right-8 border-border" orientation="vertical" />
        </>
    )
}
