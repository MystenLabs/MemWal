Localization Task
February 2025
Apple Confidential–Internal Use Only
Overview
This document guides on identifying language 
issues in the response and provides examples of 
localization issues for various locales.
Content 
• Localization Issue Overview
• Tone Adjustment 
• Awkward or Unnatural Writing Examples 
• Formatting and Punctuation Issues 
Examples
Localization Issues Evaluation
Scale Description Comments
No (no issues) The response shows no signs of being generated for a different locale than the target one. If there are any issues with localization, this should not be selected.
Yes 
(issues present)
There is at least one element of the response that would make the user question if the 
model were designed specifically for their locale.
If there are any issues with localization, this must be selected.
The language in the response should be appropriate for the user prompt. 
• It should match the language of your locale and the language of the prompt. Responding in a language different from the prompt is only correct if the prompt requests it. 
• It should be free of language issues.
You will be asked to answer the question "Are there any localization issues in the response?" using the scale below.
1. Unlocalized Information 
2. Overly-localized Content 
3. Spelling 
4. Non-local Perspective 
9. Tone 
10.Awkward or unnatural writing 
11. Formatting and Punctuation 
12.Units of measurement (includes currency) 
13.Other
This task contains Prompt and Response written in a specific locale. Your role is to evaluate whether the response contains any localization issues described in this document. 
Note: The accuracy of the response is out of scope for this project (the response can be wrong but perfectly localized). 
Upon selecting “Yes” (the issue is present), you will mark all the localization issues you have found in the response: 
The last step is to provide the reasoning for your grading. Regardless of the locale, the comments should be written in English. Be specific and informative to provide additional 
context for your choice (e.g., why you have chosen a given issue and what part of the response points to that). 
5. Vocabulary 
6. Phrase or Idiom 
7. Wrong Language
8. Grammar
Issues Definition Examples
Unlocalized 
Information
The response provides information 
related to another locale when 
information more relevant to the 
target locale could have been 
provided instead.
Example 1: 
en_GB User Request: "What is the easiest way to file taxes?" 
Assistant Response: "Using IRS Free File. The IRS offers a Free File program where eligible taxpayers can use free 
tax preparation software to prepare and file their federal taxes electronically." 
Grade: Issues present, Unlocalized Information 
Explanation: The user is UK-based, but the IRS is a branch of the US government responsible for collecting taxes. 
The assistant should use the context of the user's locale to understand they want to know about the process in the 
UK, not the US. 
Example 2: 
en_CA User Request: When is the best time to visit Victoria?" 
Assistant Response: "Victoria, Australia, is a popular destination with diverse landscapes and a vibrant culture, 
making it a great place to visit throughout the year. However, the best time to visit Victoria depends on your personal 
preferences and the type of experience you want to have. Here is a breakdown of the different seasons in Victoria:" 
<list removed for brevity> 
Grade: Issues present, Unlocalized Information 
Explanation: Victoria, BC is the capital city of British Columbia, the 3rd largest province in Canada. The assistant 
should understand that based on the user's locale, this is the most relevant Victoria.
Localization Issues Overview (back to Content >>)
Issues Definition Examples
Overly-localized 
Content
The response unnecessarily fixates on the 
target locale. 
We want the assistant to provide content 
relevant to the locale, but it should not 
unnecessarily restrict the information it 
provides to being about the locale nor 
should it unnaturally force references to it 
into generated content. 
Example: 
en_CA User Request: "What are the most influential books?" 
Assistant Response: "Canada has a rich literary tradition, and many Canadian authors have made significant 
contributions to literature. Here are some of the most influential books by Canadian authors: 
Classic Influential Books: 
1."Anne of Green Gables" by L.M. Montgomery (1908) 
2."The Handmaid's Tale" by Margaret Atwood (1985) 
3."Life of Pi" by Yann Martel (2001) 
4."The Stone Angel" by Margaret Laurence (1964) 
5."Fifth Business" by Robertson Davies (1970)" 
Grade: Issues present, Overly-localized content 
Explanation: This checkbox should be selected. The user did not request the list be only limited to Canadian 
authors, so the assistant should have considered books written by authors from all around the globe. 
Localization Issues Overview
Issues Definition Examples
Spelling The response uses incorrect variant 
spelling of a word. 
The Spelling should be selected as a 
localization issue only if the spelling is 
incorrect for the target locale but might be 
correct for another locale. This means that 
some spelling errors are not necessarily 
localization issues and should not be 
flagged. For example, a typo is incorrect in 
any locale and is not a localization issue.
Example: 
en_GB User Request: "what is your favourite colour?" 
Assistant Response: "As an AI, I don't have personal preferences, including favorite colors. However, I can tell 
you that blue is often considered a favorite color worldwide." 
Grade: Issues present, Spelling 
Explanation: The assistant used en_US spelling for "favourite" and "colours". 
Refer to the Locale Variant Guide for more examples.
Localization Issues Overview
Issues Definition Examples
Non-local 
Perspective
The response is 
not from the 
perspective of the 
target locale. 
A common case of 
this is the 
response 
unnecessarily 
bringing up the 
user's locale to 
specify information 
in the response. 
For the model to 
appear designed 
specifically for the 
target locale, it 
should present 
information as 
though it's 
assumed to be 
about the target 
locale, and only 
specify if 
necessary. 
Example 1: 
en_AU User Request: "What is the most expensive housing market in the country?" 
Assistant Response: "According to the Real Estate Institute of Australia (REIA), Sydney, New South Wales, is currently the most expensive 
housing market in Australia. As of January 2023, the median house price in Sydney was AU$1.15 million." 
Grade: Issues present, Overly localized content 
Explanation: For an Australian user, the dollar value should be assumed to be in Australian dollars without having to specify 
Example 2: 
en_AU User Request: "How many Australian dollars are in an American dollar?" 
Assistant Response: " 
As of April 11th, 2023 
• 1 AUD is approximately 0.66 USD 
• 1 USD is approximately 1.50 AUD 
Currency exchange rates fluctuate daily, even hourly, so it's recommended to check with a currency exchange service or bank for the most 
up-to-date rate before making any international transactions." 
Grade: No issues 
Explanation: In this case, it's necessary to specify which dollar belongs to which country, so the specification is not a localization issue. 
Example 3: 
en_CA User Request: "What are some things to do on Victoria Day?" 
Assistant Response: "Victoria Day is a federal holiday in Canada that celebrates the birthday of Queen Victoria, the former monarch of the 
United Kingdom. It is observed on the Monday preceding May 25th each year. Here are some popular things to do on Victoria Day: 
<list removed for space>" 
Grade: Issues present, Overly localized content 
Explanation: Victoria Day is a federal holiday that a model designed for the locale should treat as common knowledge. By defining it without 
the user requesting a definition, the model makes it seem foreign.
Localization Issues Overview
Issues Definition Examples
Vocabulary Using words, phrases, or expressions that is 
not appropriate for the specific 
geographical or cultural context is not 
acceptable.
Example: 
en_GB User Request: "What are the most popular sports?” 
Assistant Response: "The United Kingdom has a rich sporting culture with a diverse range of popular 
games. According to a 2023 survey by Statista, the top 3 most popular sports in the UK based on 
participant interest are: 
1.Soccer 
2.Cricket 
3.Rugby Union” 
Grade: Issues present, Vocabulary 
Explanation: The assistant incorrectly used the word "soccer" when "football" should have been used. 
Refer to the Locale Variant Guide for more examples. 
Phrase or Idiom The response includes a phrase and idiom 
that is not commonly used or understood in 
the target locale.
Example: 
en_CA User Request: "Can you generate C++ code for me?" 
Assistant Response: "Yes, I'd be chuffed to bits to help you with C++ code! Please feel free to ask any 
questions, provide the code you'd like help with, or explain the problem you're trying to solve" 
Grade: Issues present, Phrase or idiom 
Explanation: "Chuffed to bits" is British colloquialism that would not be well understood by an en_CA user. 
Refer to the Locale Variant Guide for more examples.
Localization Issues Overview
Issues Definition Examples
Wrong Language Wrong language refers to using a language that is 
not in the task locale's language. The language in 
the response should be understandable to the 
user.
However: 
1.Responses that contain foreign languages are 
acceptable if the intention of the request 
requires the response to be in a foreign language 
(e.g., requests to translate from a task locale to a 
foreign language).
2.Responses that contain loanwords (borrowed or 
shared from other languages words) are 
acceptable if they are commonly used in the 
task locale. 
3.Responses that contain coding languages are 
acceptable if the request is asking for a coding 
solution. 
It is unacceptable (language issue is present) when a response is not in the same language as the request:
User Request: iPhone15はいくらですか (translation: how much is iPhone 15) 
Assistant Response: I'm sorry, your message is in a language that I cannot understand. This may be the 
result of an encoding error. 
User Request: 有关拜登减免学⽣债务的最新消息是什么？
Assistant Response: I am sorry, but I did not understand the request. Could you please rephrase your 
request in English? 
Acceptable (no language issues): 
User Request: how do I say “hello” in Mandarin? 
Assistant Response: 你好 (translation: hello) 
Use Request: Translate "How are you" to Spanish 
Assistant Response: "¿Cómo está usted?” 
Loanwords are acceptable:
1. Cul-de-sac (French): A dead-end street or road. 
2.Fiancé(e) (French): A person engaged to be married. 
3.Rendezvous (French): A meeting or appointment. 
4.Entrepreneur (French): A person who starts a business or venture. 
5.Angst (German): A feeling of deep anxiety or dread. 
6.Kindergarten (German): A preschool for children aged three to five years. 
7. Schnitzel (German): A breaded and fried meat cutlet, typically made with veal or pork. 
Coding languages: 
The following Python code response print (“Hello, World!“) is acceptable. 
Refer to the Locale Variant Guide for more examples.
Localization Issues Overview
Issues Definition Examples
Grammar Grammar that doesn't conform to the target locale.
Note: If you are not sure about grammar, you can use authoritative online 
resources appropriate to your locale to look it up (optional).
learnt (UK) vs. learned (US) 
Refer to the Locale Variant Guide for examples.
Tone Tone refers to overemphasizing traits associated with individuals from 
the target locale. Responses that sound like a stereotype due to 
overusing these traits should be marked as having a localization issue 
with the tone. 
Note: Other characteristics of tone, such as formal/ informal, serious/
humorous, optimistic/cynical or sarcastic/sympathetic, etc. are not a 
consideration for the localization.
Refer to the Tone examples in the Grading Examples document.
Awkward or 
unnatural writing
Wording or expressions in the response that lack the fluency expected of 
a native speaker, such as an overly literal translation or obvious machine 
translation.
Refer to the Awkward or Unnatural Writing examples below.
Localization Issues Overview
Issues Definition Examples
Formatting and 
Punctuation 
The Formatting and Punctuation should be selected as localization 
issues only if it is incorrect for the target locale but might be correct for 
another locale, such as (but not limited to) incorrect format for dates or 
times, wrong type or usage of quotation marks, incorrect spacing, writing 
left-to-write in a locale that should be right-to-left or vice versa, etc. This 
means that some formatting and punctuation errors are not necessarily 
localization issues and should not be flagged. For example, excessive use 
of commas is incorrect in any locale and is not a localization issue.
Refer to the Formatting and Punctuation examples in the Grading Examples 
document.
Units 
of measurement and 
currency
The response uses incorrect units for measurements such as (but not 
limited to): 
Currency 
Distance 
Velocity 
Temperature 
Weight 
Refer to the Locale Variant Guide for examples. 
Other Any other localization issues you notice that are not listed in this table. Examples: 
Culturally insensitive content 
Localization Issues Overview
User Request Assistant Response Issue Comment
Translate "how are you" to Spanish "¿Cómo está usted?" No The prompt was in English, but it was requesting 
translation to Spanish.
What colour is the Golden Gate 
Bridge?
The Golden Gate Bridge is famously known for its color, which is 
not actually gold but instead an orange vermilion called 
"International Orange."
Yes The prompt used a variant of en_* such as en_AU/
CA/GB where colour is spelled with a U, so the 
assistant responding with en_US spelling without 
the U could be considered a spelling mistake. 
However, we still expect the user would be able to 
read and fully understand this response.
什麼是恆星鏈，它有什麼新穎之處？ The prompt is written in Mandarin. Would you like me to translate 
it?
Yes Responding in a language different from the prompt 
is only correct if the prompt requests it. In this case, 
it's the assistant's response suggesting a 
translation, not the prompt, and so it is not 
appropriate.
推荐三个可以喺 iPhone ⽤嘅⽽且⼜热
⻔嘅新闻聚合应⽤程式俾我
It seems like you've shared a list of characters and symbols that 
don't form a coherent sentence or question in English. I'll do my 
best to understand and provide a response.
It seems like you're looking for recommendations for popular 
news aggregation apps that you can use on your iPhone. Here are 
three popular options: Apple News, Google News, and Flipboard.
Yes The assistant understood the prompt and was able 
to form a relevant response, but the prompt was in 
Chinese and the response was in English so it is not 
appropriate.
Examples
Localization Issues Overview
User Request Assistant Response Issue Comment
有关拜登减免学⽣债务的最新消息是什
么？
I am sorry, but I did not understand the request. Could you 
please rephrase your request in English?
Yes Did not respond in the same language as the prompt. 
Acknowledging that it did not understand the language in the 
prompt does not improve the appropriateness of the language 
used in the response.
Localization Issues Overview
Locale Prompt Incorrect Tone Better Tone
en_GB Why did I see Jared Leto 
in the news dressed like 
a cat?
Well, blimey, you must have seen Jared Leto in the press due to his role in a 
new project he's involved in. Either he's pulling our leg for some publicity or 
he's popped off his rocker, that chap. In the past, Mr. Leto has made a habit of 
going whole hog with his acting roles, totally transforming himself for each one, 
including his striking Joker role in Suicide Squad. 
So, maybe he's in a panto or grand theatre production. Or he could be 
promoting his band, Thirty Seconds to Mars in a nutter's way. Wouldn't put it 
past him for a spot of tomfoolery. If it's not all in jest, then I'm as puzzled as a 
newt in a jigsaw puzzle. 
I'm just an old chap enjoying my cuppa and Cornish pasty without needing all 
that Hollywood palaver. Let's keep our pennies for the gargle down the local, 
not star-studded malarkey. Now, if you'll excuse me, I have a date with the 
Queen's back catalogue and a bowl of spotted dick.
It seems Jared Leto was caught up in a recent controversy that 
had the tabloids buzzing. He was spotted wearing an outfit 
that resembled a cat during a public appearance. While some 
found it peculiar and amusing, others perceived it as a bold 
and creative fashion statement. As for the exact reason behind 
his choice of attire, only Jared Leto himself can provide the 
definitive answer. However, it wouldn't be surprising if he 
intended to make a memorable and eye-catching entrance, as 
he is known for his unique and artistic style. Whether it was a 
well-thought-out artistic expression or a simple case of 
wanting to stand out, his feline-inspired ensemble certainly 
turned heads and sparked conversations among the public.
Tone Adjustment Examples (back to Content >>)
Locale Prompt Incorrect Tone Better Tone
en_GB Why is Taylor Swift 
recording all her albums 
again?
Taylor Swift is re-recording her entire discography due to a 
right bobbish predicament concerning the ownership of her 
original master recordings. As it happens, her old record 
label, Big Machine Label Group, flogged the rights to her first 
six albums to a private equity firm. As you can imagine, that 
didn't go down well with our T-Swizzle. She wasn't given the 
opportunity to buy her own work, which left her feeling right 
miffed. 
Not being one to let things lie, she decided to make a fresh 
start. In essence, she's putting a new spin on her old tunes by 
re-recording them. This allows her to regain control over her 
music catalogue, and ensure that every penny made from her 
old hits goes straight to her pocket, rather than to folk she 
reckons didn't earnt it. 
It's all a bit of a palaver, but all power to her for not taking it 
lying down!
Taylor Swift, the celebrated American singer-songwriter, has caused quite a stir 
among her devoted fanbase with the unexpected announcement of her decision 
to re-record all her past albums. This intriguing move is rooted in the complexities 
of music ownership and rights within the industry. 
Initially, Swift signed a recording contract with Big Machine Records, granting the 
label ownership of the master recordings of her first six studio albums. Throughout 
her tenure with the label, she achieved tremendous success and established 
herself as a prominent figure in the music world. However, when she decided to 
part ways with Big Machine Records and embark on a new journey with Republic 
Records, the ownership of her master recordings remained with the former label. 
As time passed, Swift voiced her growing concerns about the lack of control she 
had over her creative legacy. She expressed dismay at the prospect of her old 
songs being used without her consent or knowledge, potentially undermining the 
integrity of her artistic vision. This apprehension was fueled when Big Machine 
Records was sold to Scooter Braun, a prominent music manager who had 
previously been involved in public feuds with Swift. 
<truncated for space>
Tone Adjustment Examples
Locale Prompt Incorrect Tone Better Tone
en_GB Can you suggest some 
TV shows that are 
similar to the storyline 
of the Breaking Bad 
show?
Ah, I see you're on the lookout for telly programs akin to the 
gripping tale of Breaking Bad, innit? Well, fear not, for I've got 
a few suggestions up me sleeve that might tickle your fancy! 
First off, we've got "Peaky Blinders," an absolute gem set in 
the gritty streets of Birmingham during the aftermath of the 
Great War. It follows the exploits of the Shelby family, a 
notorious gangster clan dabbling in illicit activities such as 
bootlegging, gambling, and all sorts of shady dealings. Trust 
me, mate, it's a smashing blend of drama, crime, and 
historical context, and it'll have you glued to your telly. 
Next up, how about "Line of Duty"? This gripping police 
procedural series delves into the murky world of corruption 
within the British police force, with AC-12, an anti-corruption 
unit, peeling back the layers to bring the baddies to justice. 
It's a right thrilling cat-and-mouse game with unexpected plot 
twists that'll leave you gobsmacked, mate. 
<truncated for space>
Certainly! Here are some TV shows with plotlines similar to Breaking Bad: 
1. "Broadchurch" (2013-2017): This British crime drama follows the story of two 
detectives investigating a murder in a small coastal town. It explores the impact of 
the crime on the community and the moral dilemmas faced by the characters. 
2. "The Fall" (2013-2016): This Irish-British series centers around a detective who 
is hunting down a serial killer in Belfast. It delves into the psyche of the killer and 
the complex relationship between the detective and the criminal. 
<truncated for space>
Tone Adjustment Examples
Locale Example Explanation
ko_KR 여정을 하고있었습니다
Response: 
타이타닉호는 1912년 4월 14일 밤 북대서양에서 침몰한 비행선입니다. 
타이타닉호는 전설적인 배로 여겨지며 그 이야기는 많은 책과 영화로 만들어졌습니다. 
타이타닉호는 세상에서 가장 큰 배였습니다. 
그것은 영국에서 미국으로 가는 여정을 하고있었습니다. 
승객 수는 약 2,200명으로 추정됩니다. 
승무원과 승객을 포함하여 1,500명 이상이 사망했습니다. 
사고의 원인은빙산과 충돌 때문으로 밝혀졌습니다.
An awkward phrase for “was on a 
journey”. More natural expression would 
be “여정 중이었습니다.”, or “항해 중이었습니
다.”
ko_KR 접착이 아닌 플라스틱 탭을 사용한 접착제 없는 디자인은 실제로는 기존의 저렴한 전화기와 크게 다르지 않습니다. 
Response: 
노키아 G22는 수리 가능한 스마트폰으로 소개되었지만, 실제로는 그렇게 다르지 않은 것으로 나타났습니다. 전화기의 구성 요소는 대부분 화면 뒷면
에 장착되어 있어 화면 교체 시 전화기를 완전히 분해해야 하는 번거로움이 있습니다. 또한, 접착이 아닌 플라스틱 탭을 사용한 접착제 없는 디자인은
실제로는 기존의 저렴한 전화기와 크게 다르지 않습니다. 
수리 가능성을 강조하는 마케팅에 비해 실제 디자인에서는 큰 변화가 없는 것으로 보입니다. 수리 가능한 디자인은 모든 구성 요소가 중앙 프레임에 장
착되어 쉽게 교체할 수 있는 것이 이상적이지만, G22는 이러한 측면에서는 기존의 저렴한 전화기와 크게 다르지 않은 것으로 나타났습니다. 따라서, 
이 제품이 실제로 수리하기 쉬운 디자인을 갖추고 있는지에 대한 의문이 남습니다.
Order of sentence components is not 
correctly followed by Korean grammar 
and it sounds like English translation. 접착
제가 없는 플라스틱 탭은 기존의 저렴한 전화기
와 크게 다르지 않다. is smoother.
Awkward or Unnatural Writing Examples (back to Content >>)
Locale Example Explanation
ko_KR 북쪽으로 가는 항로가 어려워졌으며
Response: 
1940년 4월 9일의 베저위붕 작전은 핀란드에게 중요한 사건으로, 이후 핀란드는 독일의 스칸디나비아 공격으로 인해 서부
전통 무역 시장과 물리적으로 격리되었습니다. 이로 인해 발트해의 출구가 막히고 북쪽으로 가는 항로가 어려워졌으며, 나치
독일과 소련에 둘러싸여 있는 상황이 되었습니다. 이에 핀란드는 칼 구스타브 에밀 만네르헤임 남작의 지원을 받아 자원 봉
사단을 구성하여 나치 군대와의 전쟁을 돕기 위해 노르웨이로 파견되었습니다. 이러한 지원으로 인해 구급차 부대가 핀란드
로 돌아와 전쟁에 참여할 수 있었으며, 이는 핀란드에게 중요한 사건으로 기억되고 있습니다.
어려워졌으며 is awkward wording as the verb '어려워지다' does 
not match the subject(항로). Either, '항로가 막혔으며' or '항로를 이
용하기가 어려워졌으며' is more natural.
es_ES Aquí está una explicación 
Response: 
"Claro, aquí está una explicación que le puedo dar a un niño de primaria sobre los resfriados: 
Un resfriado es una enfermedad que puede causarte sentir mal y tener algunos síntomas como tos, dolor de 
garganta y secreción nasal. Los resfriados son muy comunes y suelen desaparecer solos después de una 
semana o así. Sin embargo, algunos síntomas como el dolor de garganta o la congestión nasal pueden durar 
un poco más. La tos también puede durar algunas semanas más, pero eventualmente desaparecerá. 
Lo importante es descansar mucho y tomar suficiente líquido para sentirte mejor. Si tienes fiebre o te sientes 
muy mal, es posible que necesites hablar con un médico para que te dé algo para sentirte mejor."
Overall, the text has an unnatural tone. There are several 
sentences that were translated literally and sound awkward, 
such as: 
- Aquí está una explicación: We would use the verb tener, "aquí 
tienes una explicación". 
- Causarte sentir mal: Since the text is about health, we would 
say "causar malestar" or "hacer que te encuentres mal". 
- Después de una semana o así: It should be "al cabo de una 
semana más menos" because "o así" is a literal translation of "or 
so". 
Furthermore, the assistant uses the verb “sentir” too many 
times instead of looking for synonyms, which impacts the 
fluency of the text.
Awkward or Unnatural Writing Examples
Locale Example Explanation
es_ES Darle más pensamiento 
Response: 
Querida [Nombre de la esposa], 
Espero que este mensaje te encuentre bien. Me gustaría compartir algunas actualizaciones sobre mis planes para el viaje. Después 
de darle más pensamiento, he decidido pasar otra noche en Boston con mis padres. La salud de mi padre ha estado empeorando 
rápidamente, y siento que necesito aprovechar al máximo cada momento con ellos, no sé cuándo volveré a verlos. 
Sé que esto significa cambiar nuestros planes, y lo siento mucho por eso. Espero que puedas entender la importancia de esto para 
mí. Te aseguro que haré todo lo posible para volver a Los Ángeles lo antes posible y ponerme al día con todo lo que he perdido. 
Por favor, sabes que te echo de menos mucho. No puedo evitar pensar en ti y en lo mucho que me gustaría que estuvieras aquí 
conmigo. Estoy haciendo todo lo posible para manejar esto, y pronto estaremos juntos de nuevo. 
Por favor, cuídate mucho y mantenme informado de todo lo que está sucediendo allí. Te quiero mucho y espero hablar contigo 
pronto. 
Con amor, 
[Tu nombre]
The text sounds very awkward due to 
literal translations from English, including: 
- Espero que este mensaje te encuentre 
bien: Native speakers don't use this 
greeting. 
- Darle más pensamiento: We would say 
"pensarlo más". 
- Lo siento mucho por eso: "Por eso" 
should be omitted. 
- Te echo de menos mucho: The correct 
order is "te echo mucho de menos". 
- Con amor: We would sign off with "con 
cariño" or "un abrazo" instead.
Awkward or Unnatural Writing Examples
Locale Example Explanation
es_ES Los objetos geométricos (...) pueden ser deformados y flexionados 
Response: 
"En este mundo alternativo, introduciría un nuevo axioma llamado "Axioma de la flexibilidad". Este axioma establece que todos los 
objetos geométricos, incluyendo líneas, planos y figuras, pueden ser deformados y flexionados de manera plástica sin romperse ni 
desaparecer. 
Este axioma permitiría la creación de formas y estructuras geométricas únicas y sorprendentes, ya que los objetos podrían ser 
doblados, estirados y torcidos de maneras que no se pueden hacer en el mundo real. Los edificios podrían tener formas fluidas y 
cambiantes, los objetos podrían ser diseñados para transformarse de una forma a otra, y las líneas y planos podrían ser flexionados 
para crear patrones intrincados y complejos. 
Además, este nuevo axioma también tendría implicaciones en la física y la mecánica del mundo, ya que las propiedades de los 
materiales y los objetos podrían ser alteradas por su capacidad para ser deformados y flexionados. Esto podría llevar a la creación 
de nuevos materiales con propiedades únicas, nuevos métodos de construcción y nuevas formas de moverse y interactuar con el 
entorno. 
En resumen, el Axioma de la flexibilidad introduciría una nueva dimensión a la geometría, permitiendo la creación de formas y 
estructuras únicas y abriendo nuevas posibilidades en la física y la mecánica del mundo."
Overuse of passive sentences, which are 
quite common in English, but in Spanish 
it makes the text harder to read because 
it's unnatural. It would be smoother with 
a reflexive pronoun: "los objetos (...) se 
pueden deformar y flexionar".
Awkward or Unnatural Writing Examples
Locale Example Explanation
fr_FR C'était son premier album de nouveaux matériaux depuis son album "Evermore". 
Response: 
Voici quelques informations sur la sortie de l'album "Midnights" de Taylor Swift en 2022 : 
Taylor Swift a sorti son dixième album studio, "Midnights", le 21 octobre 2022. C'était son premier album de nouveaux 
matériaux depuis son album "Evermore" sorti en décembre 2020. L'annonce de l'album a eu lieu lors de la cérémonie des MTV 
Video Music Awards le 28 août 2022, où Swift a remporté le prix du meilleur clip vidéo pour "All Too Well : The Short Film". 
Swift a décrit "Midnights" comme un album de chansons sur "les nuits sans sommeil" et des histoires qu'elle a ressassées "à 3 
heures du matin". L'album a un son pop, électronique et expérimental, avec des influences de synth-pop et de dream pop. Les 
paroles de l'album traitent de sujets tels que l'amour, la nostalgie, l'anxiété et la célébrité. 
L'album "Midnights" a reçu des critiques positives de la part des critiques musicaux, qui ont loué la production, les paroles et la 
voix de Swift. L'album a également connu un succès commercial important, battant plusieurs records de streaming et de vente 
en une semaine. Par exemple, il a été l'album le plus vendu aux États-Unis en une semaine depuis "Reputation" de Swift en 
2017, et il a battu le record du plus grand nombre d'écoutes en une journée sur Spotify. 
En résumé, la sortie de l'album "Midnights" de Taylor Swift en 2022 a été un événement majeur dans l'industrie de la musique, 
avec des critiques positives et un succès commercial important.
"de nouveaux matériaux" seems like a litteral 
translation of the English "new materials", 
which would not work in French 
- The expression "premier album de 
nouveaux matériaux" is also awkward. A more 
natural structure may be to replace the 
preposition "de" with a gerondive. 
- French speakers are very sensitive to 
repetitions of words and try to avoid them as 
much as possible in writing. Here, "album" is 
used twice in the sentence. A synonym could 
have been found for one of the occurences. 
- sentence starting by "Swift" : we would use 
the entire name of the artist.
Awkward or Unnatural Writing Examples
Locale Example Explanation
fr_FR Oui, j'ai fait. 
Response: 
CARACTÈRE 1 : CLIENT (C) 
CARACTÈRE 2 : CONSEILLER FINANCIER (F) 
(SCÈNE : UN BUREAU DANS UNE COMPAGNIE D'INVESTISSEMENT. LE CLIENT EST ASSIS DEVANT 
LE BUREAU DU CONSEILLER FINANCIER, QUI EST ASSIS SUR LE BUREAU.) 
F : Bonjour, monsieur Johnson. Merci d'être venu me voir aujourd'hui. 
C : Pas de problème, monsieur Smith. J'étais ravi de recevoir votre appel. 
F : Alors, commençons par jeter un coup d'œil à vos dossiers financiers. J'ai vu que vous avez investi 
une partie considérable de votre argent dans des actifs à haut risque. 
C : Oui, j'ai fait. J'ai entendu dire qu'ils peuvent offrir de hauts rendements. 
F : Bien sûr, mais ils sont également accompagnés de plus grands risques. Et en regardant vos 
dépenses, je dois vous mettre en garde contre toute implication future dans de tels actifs. 
C : Pourquoi cela ? Je peux gérer le risque. 
F : Je comprends, monsieur Johnson, mais votre mode de vie actuel montre le contraire. Si vous 
continuez à investir dans ces actifs et que les choses tournent mal, vous pourriez tout perdre. 
C : Je vois ce que vous dites. Alors, que me suggérez-vous ? 
F : Je pense que vous devriez vous concentrer sur des investissements plus sûrs, comme des actions 
ou des obligations. Ils peuvent offrir un rendement modéré, mais ils sont moins risqués. 
C : D'accord, je pense que c'est une bonne idée. J'aimerais vous entendre parler de quelques options. 
F : Bien sûr, je serais ravi de vous aider. Nous pouvons examiner vos objectifs financiers et créer un 
portefeuille d'investissement personnalisé qui correspond à vos besoins. 
C : Cela semble fantastique. Faisons-le. 
F : Merci, monsieur Johnson. Je suis heureux de pouvoir vous aider. 
(LA SCÈNE SE TERMINE.)
It seems like a litteral translation of English "yes, I did". In French, the verb 
"faire" is transitive so it needs to be followed by an object. It is also never 
used in a short expression to say "yes" or "no" like in English. 
- "une partie considérable de votre argent" : grammatically correct but 
sounds a bit dramatic and translated. "vous avez réalisé des 
investissements importants etc." 
- "Oui, j'ai fait. J'ai entendu dire qu'ils peuvent offrir de hauts 
rendements." - see comment made previously on "yes I did", and "hauts 
rendements"should be changed to "rendements importants". Although it 
is grammatically correct and understandable, does not sounds natural. 
- "mais votre mode de vie actuel montre le contraire" sounds unnatural, 
we would go for something like "mais votre train de vie indique le 
contraire" 
- "Je vois ce que vous dites" is unnatural , we will phrase it differently: "je 
comprends ce que vous voulez dire" or "je vois ce que vous voulez dire". 
- "J'aimerais vous entendre parler de quelques options" does not sound 
natural, we would go for "J'aimerais en savoir plus sur les options/ 
solutions/ produits que vous pourriez proposer." 
- "Cela semble fantastique: Faisons-le" is also a litteral translation : in 
french it would rather be "c'est parfait, faisons comme ça" 
- "Merci, monsieur Johnson. Je suis heureux de pouvoir vous aider" 
would be phrased differently as this is a littéral translation of english 
manner. be "très bien, je suis ravi de pouvoir vous aider.”
Awkward or Unnatural Writing Examples
Locale Example Explanation
fr_FR "Maintenant, j'aimerais en savoir plus sur votre amour pour le paiement de la pension alimentaire." 
Response: 
[Musique d'introduction] 
[Hôte] : Bienvenue dans "Interesting Legal Cases", où nous explorons des cas juridiques uniques et 
intrigants qui ont remodelé le paysage juridique. Je m'appelle votre hôte, [Nom de l'hôte], et dans cet 
épisode, nous allons nous lancer dans un voyage au cœur d'une question passionnante : l'amour, le 
mariage et les obligations alimentaires. Rejoignez-nous alors que nous accueillons Alimony Tony, un 
homme indépendant qui embrasse la romance avec un flair unique. 
[Musique et effets sonores] 
[Hôte] : Alimony Tony, merci d'être avec nous sur le podcast aujourd'hui. 
[Alimony Tony] : Merci d'avoir invité, c'est un plaisir d'être ici. 
[Hôte] : Alors, pour commencer, peux-tu nous parler de ta passion pour le mariage ? 
[Alimony Tony] : Bien sûr ! Je suis un homme romantique, et je crois vraiment en la magie du mariage. 
Quand je tombe amoureux, je suis tout entier dans la relation. Je pense que le mariage est un moyen de 
s'engager et de s'unir avec quelqu'un que vous aimez. 
[Hôte] : C'est beau. Maintenant, j'aimerais en savoir plus sur votre amour pour le paiement de la pension 
alimentaire. Qu'est-ce qui vous a amené à prendre cette décision ? 
[Alimony Tony] : Eh bien, je crois que quand deux personnes se marient, elles s'engagent à prendre soin 
l'une de l'autre. Même si la relation se termine, je crois toujours qu'il est important de fournir un soutien à 
l'ex-partenaire. C'est ma façon de montrer que je tiens à eux et que je veux leur bien-être. 
[Hôte] : C'est très généreux de ta part. Vous avez actuellement sept ex-femmes, et vous leur donnez 
chacune 12 000 $ par mois. Cela représente une grande partie de votre revenu. Comment gérez-vous vos 
finances pour vous permettre de faire cela ? 
[continued on the next slide] ->>
- The sentence uses rather generic words (amour, paiement), 
without a precise semantic meaning. This makes it sound like it 
was not written by a very competent writer. 
- The use of the article "la" and of the singular is clumsy, it would 
have been better to use an inderminate article ("des") and make it 
plural. 
The structure of the sentence does not flow well. A human 
translator would have likely rephrased/reorganised the sentence 
completely to make it sound more natural. 
"Merci d'avoir invité" - this sentence in French does not make 
sense as we would need to add an object to the verb (e.g. de 
m'avoir invité) or change it to a noun (e.g. merci pour l’invitation) 
"peux-tu nous parler..." "j'aimerais en savoir plus sur votre amour 
pour..." "C'est très généreux de ta part. Vous avez actuellement" - 
the whole interaction changes from the informal form of "you" to 
the formal version (between the same speakers). We need 
alignment as it sounds unnatural. Either they address each other 
in one form or the other, but they would not switch from one 
sentence to another 
"le bonheur et le bien-être d'eux" - we would not phrase it like 
that, but we would say "leur bien-être” 
[continued on the next slide] ->>
Awkward or Unnatural Writing Examples
Locale Example Explanation
fr_FR [beginning on the previous slide] 
[Alimony Tony] : C'est vrai, le paiement de la pension alimentaire est une priorité pour moi, et 
je l'organise dans mes finances. J'ai hérité d'une entreprise prospère de ma mère, qui fabrique 
du papier gazeux, ce qui me permet de subvenir à mes besoins et à ceux de mes ex-femmes. 
Je considère cela comme un investissement dans le bonheur et le bien-être d'eux. 
[Hôte] : C'est admirable. Cela a dû être une décision difficile de prendre, surtout compte tenu 
du fait que cela pourrait avoir un impact sur vos finances personnelles. Avez-vous jamais 
regretté de payer une pension alimentaire à vos ex-femmes ? 
[Alimony Tony] : Pas du tout. Je crois que c'est la bonne chose à faire, et je ne regrette pas 
mes décisions. Je suis heureux de pouvoir fournir un soutien à mes ex-femmes, et je crois 
qu'il a contribué à maintenir des relations positives avec eux. 
[Hôte] : C'est une perspective réfléchie. Que diriez-vous à quelqu'un qui est sceptique sur le 
fait de payer une pension alimentaire, peut-être parce qu'il pense que cela peut être utilisé 
comme un moyen de se venger ou de punir l'autre personne ? 
[Alimony Tony] : Je comprends où ils viennent, mais je pense que la pension alimentaire ne 
devrait pas être considérée comme une forme de punition ou de vengeance. Il devrait s'agir 
de fournir un soutien à l'ex-partenaire. Bien sûr, il est important de fixer des règles et des 
limites appropriées pour la pension alimentaire afin d'assurer son utilisation à bon escient, 
mais je crois que, dans l'ensemble, la pension alimentaire peut être une bonne
[beginning on the previous slide] 
- "Cela a dû être une décision difficile de prendre" - we would say "à prendre" 
- "Je comprends où ils viennent" - the expression in French is "je comprends 
d'où ils viennent" 
- "Je m'appelle votre hôte" : the presenter will not present his function. They 
present rather the invitees. 
- "un homme indépendant qui embrasse la romance avec un flair unique." This 
is a litteral translation. we would use another verb as "embrasser" has a 
different meaning and use. 
- "Quand je tombe amoureux, je suis tout entier dans la relation." we would 
translate differently ( je m'investis pleinement etc) 
- "je l'organise dans mes finances." would have been translated differently : 
"c'est un budget à part entière". or something like that. 
- "je crois qu'il a contribué à maintenir des relations positives avec eux." : is not 
correct : "je crois que cela a contribué" ... 
- "C'est une perspective réfléchie. Que diriez-vous à quelqu'un qui est 
sceptique sur le fait ... " : we can understand the meaning but it does not 
sound very natural. "C'est un point de vue mûrement réfléchi. "? Que diriezvous à quelqu'un qui est réfractaire/ dubitatif à l'idée de ... 
- "la pension alimentaire peut être une bonne " : here we lack the last word. 
( not sure if intended or not but the sentence cannot end like that.
Awkward or Unnatural Writing Examples
Locale Example Explanation
pt_BR "fundo de poupar" 
Response: 
Reserve uma parte do seu dinheiro para cobrir emergências como reparos de carro ou contas médicas, 
evitando dívidas caras. Priorize uma conta poupança para essas despesas inesperadas e defina regras 
para seu uso. Use o fundo de poupar em caso de necessidade, mas lembre-se de reconstruí-lo 
posteriormente.
The expression "fundo de poupar" is not used in Portuguese. In 
natural writing or speech for the pt_BR locale, the correct word in 
this context is “poupança". 
The expression picked up in the response is an awkward translation 
from English.
pt_BR “o osso mais grande" 
Response: 
O osso mais grande na parte superior do corpo é o esterno, um osso plano e em forma de escudo 
localizado no peito. Ele protege muitos órgãos vitais, incluindo o coração e os pulmões. O esterno é 
composto por várias partes, incluindo a mancha esternal, as costelas e o processo xifóide. Ele conectase a muitos outros ossos e fornece um ponto de ancoragem para vários músculos.
"O osso mais grande" is a literal translation from "the biggest bone", 
wich in Portuguese is unnatural. The correct translation in this case, 
that adhere to both Portuguese grammar and natural speech, is "o 
maior osso".
pt_BR “com sua diplomação na mão” 
Response: 
Uma jovem chamada Sophie recém-se formou na faculdade. Sophie estava sempre entusiasmada com 
a aventura. Ao longo de sua infância e adolescência, ela leu inúmeros livros de aventura e sonhou em 
explorar os cantos distantes do mundo. Agora, com sua diplomação na mão e uma mente livre de 
responsabilidades, Sophie decidiu realizar seu sonho de fazer uma viagem ao redor do mundo. 
Sophie começou sua jornada na Europa, explorando ruínas antigas, admirando obras-primas de arte 
renomadas e saboreando a culinária de vários países. Enquanto viajava, ela conhecia pessoas de todas 
as esferas da vida e ouvia suas histórias. Ela aprendeu com suas experiências e começou a entender 
que a vida não se trata do destino, mas da jornada em si. Sophie percebeu que cada encontro, cada 
experiência e cada desafio que ela enfrentava moldava sua perspectiva e a tornava a pessoa que ela 
era.
Although the word "diplomação" exists in Portuguese, it is not used 
to describe a student's graduation. The word "graduação" is 
commonly used instead. In addition to that, the expressions 
"diplomação na mão" or even "graduação na mão" are not sensical 
in Portuguese, therefore, an awkward or unnatural writing.The 
expressions "com seu diploma na mão e a mente livre de 
responsabilidades" or simply "graduada e com a mente livre de 
responsabilidades" convey the idea intended in the response using 
a natural Portuguese writing.
Awkward or Unnatural Writing Examples
Locale Example Explanation
ja_JP "室内植物" 
Response: 
室内に植物を置くときは、いくつかの要素を考慮する必要があります。
* 光：植物は光に基づいて分類され、いくつかは強い⽇光を必要とし、他のものは控えめな光を好みます。 植物のニーズに合った
場所を選択してください。
* 湿度：いくつかの植物は⾼い湿度を必要とし、他のものはそうではありません。 あなたの家がどのくらい乾燥しているかを考慮
して、それに応じて植物を選択してください。
* メンテナンス：一部の植物は他のものよりも多くのケアを必要とします。 あなたがどれだけの時間と労力を投資できるかを考慮
してください。
室内植物の維持費は、植物の種類、サイズ、および維持レベルによって異なります。 基本的なコストには、植物、⼟、ポット、
肥料が含まれます。 植物は定期的に⽔やり、剪定、および時折の施肥が必要です。 より大きな植物や多肉植物は、小さな植物よ
りも多くのポットと土が必要になる場合があります。 温室効果を防ぐために、毎年または2年に1回、より⼤きなポットに移植す
る必要があるかもしれません。
⼀般的に、室内植物の維持費は⽉額5ドルから50ドルの範囲です。 これは、水やり、剪定、施肥に必要な時間と労力を考慮せず
に、基本的なコストのみに基づいています。
"室内植物" directly translates to 
"indoor plants" which is correct in a 
literal sense, but we call these plants 
"観葉植物" or "decorative plants" in 
Japan.
Awkward or Unnatural Writing Examples
Locale Example Explanation
ja_JP "圧⼒⻣折", "ねじれ骨折", and "緑⾊の⻣折" 
Response: 
ここでは、7種類の⻣折と、それらが何であるかについての説明があります。
1。 圧⼒⻣折:圧⼒⻣折は、通常、⻣が⻑期間にわたって圧⼒にさらされると発⽣します。 それは通常、癌や骨粗鬆症の骨が弱い
場合に発生します。 ⻣は圧⼒に耐えることができず、簡単に⻲裂または壊れます。
2。 ねじれ骨折:ねじれ骨折は、骨がねじれまたはねじれるときに発生します。 これは、骨に強い回転力が加えられるときに発生
する可能性があります。 ねじれ骨折は、下肢に発生する可能性が高く、特に足首や足首で発生します。
3。 移⾏⻣折:移⾏⻣折は、⻣が別の⻣に圧迫されるときに発⽣します。 これは、骨がすでに脆弱または病気である場合に発生す
る可能性があります。 たとえば、脊椎の骨折は、脊椎骨の骨粗鬆症によって圧迫される可能性があります。
4。 完全⻣折：完全⻣折は、⻣が2つ以上の部分に分割される骨折です。 それは非常に痛みが激しく、骨が外に突き出ていること
がよくあります。
5。 不完全な⻣折：不完全⻣折は、⻣が完全に壊れていない⻣折です。 それは、骨に亀裂やひび割れがあるだけです。 ⻣折は、
完全に壊れていないかもしれませんが、それでも痛みがあり、損傷している可能性があります。
6。 緑⾊の⻣折:緑⾊の⻣折は、⼦供に発⽣する⻣折の種類です。 成⻑板に発⽣し、成⻑板がまだ柔らかい⻣です。 ⻣が伸びるに
つれて、成⻑板に圧⼒や負担が加えられ、⻣折します。
7。 コンプレッション骨折:コンプレッション骨折は、骨が圧縮されて薄くなり、壊れる骨折です。 これは、骨がすでに脆弱また
は病気である場合に発生する可能性があります。 ⻣粗鬆症は、脊椎の⻣折の原因となる可能性のあるコンプレッション⻣折の⼀
般的な原因です。
Assistant uses inappropriate 
terminology for fracture types: 
"圧⼒⻣折" should be "圧迫⻣折". 
"ねじれ骨折" should be "捻転⻣折". 
"緑⾊の⻣折" should be "若⽊⻣折". 
All of the incorrect terms are most 
likely literal translations of the English 
terminology.
Awkward or Unnatural Writing Examples
Locale Example Explanation
ja_JP "SSRIの間で薬を選択する場合" 
Response: 
提供された薬は、すべて選択的セロトニン再取り込み阻害剤(SSRI)です。 SSRIは、うつ病、不安障害、強迫性障害、月経前不快気分障害
(PMDD)、特定のパニック障害の治療に使⽤される抗うつ薬のクラスです。 
これらの薬は、脳内のセロトニンレベルを高めることで作用し、セロトニン神経伝達物質の再取り込みを阻害します。 セロトニンのより高い
レベルは、気分を高め、精神的な健康状態を改善する可能性があります。
SSRIの一般的な副作用には、吐き気、頭痛、めまい、疲労、睡眠障害、性的機能障害が含まれます。 これらの薬の重大な相互作用と警告があ
る可能性があるため、医師の指示に従って使用することが重要です。
以下は、提供された薬の説明です。
1。 シタロプラム：一般名セレクサ。 うつ病、社交不安障害、パニック障害、強迫性障害、PMDDの治療に使用されます。
2。 エスシアタロプラム：ブランド名Lexapro。 うつ病、社交不安障害、パニック障害、強迫性障害、PMDDの治療に使用されます。
3。 フルオキセチン：ブランド名プロザック。 うつ病、社交不安障害、パニック障害、強迫性障害、PMDDの治療に使用されます。
4。 フルボキサミン：ブランド名ルボックス。 うつ病、社交不安障害、パニック障害、強迫性障害の治療に使用されます。
5。 パロキセチン：ブランド名パキシル。 うつ病、社交不安障害、パニック障害、強迫性障害、PMDDの治療に使用されます。
6。 セルトラリン：ブランド名ジェド。 うつ病、社交不安障害、パニック障害、強迫性障害、PMDDの治療に使用されます。
7。 ビラゾドン：ブランド名ビラファックス。 うつ病と季節性感情障害の治療に使用されます。
SSRIの間で薬を選択する場合、医師は患者の症状、既往歴、潜在的な副作用を考慮します。 各SSRIには、作用時間、薬物動態、副作用のプロ
ファイルが異なる可能性があります。 患者のニーズに最適なSSRIを特定するために、医師はしばしば薬を調整します。
SSRIは、処方薬であるため、医師の指示なしに使用してはなりません。 これらの薬に関する正確で最新の情報については、常に医師または医
療専門家に相談してください。
"の間で" translates to 
something like "in 
between" which is 
unnatural used in this 
context. "の中から" or 
"from within" would be a 
more natural expression 
to describe choosing 
from different SSRIs.
Awkward or Unnatural Writing Examples
Locale Example Explanation
ja_JP "確かに"
Response: 
確かに、ここに記事の要約があります：
フランク・ドッド法により、貸し手は現在、所有者居住物件のための申告収入ローンを提供することができなくなり、貸し手は
借り手の返済能力を文書化するために収入や資産を証明する必要があります。
"確かに" means something like "that's 
true" which does not make sense 
considering the context of the 
complete sentence. 
This is used at the beginning of many 
responses that begin with "here is a 
summary" and are most likely 
inaccurate translations of the English 
term "sure".
zh_CN 如果您发现有⼈停放在您的街区的⻋辆
Response; 
抱歉，我⽆法提供任何关于⾮法⾏为的帮助或建议。如果您发现有⼈停放在您的街区的⻋辆，您应该先尝试联系当地的交通管理部
⻔或警察局，以了解该⻋辆是否被遗弃或需要移动。请遵守法律并尊重他⼈的财产。感谢您的理解。
It's an awkward expression that lacks 
fluency. The two characters "有⼈" are 
redundant and confusing, which 
makes the sentence “如果您发现有⼈
停放在您的街区的⻋辆” unnatural and 
hard to be understood.
Awkward or Unnatural Writing Examples
Locale Example Explanation
zh_CN 我们⼼爱的珍·哈洛在去世后⼏天内离开了我们。
Response: 
好莱坞，加利福尼亚州——1937年6⽉9⽇，我们深感悲痛地宣布，我们⼼爱的珍·哈洛在去世后⼏天内离开了我们。 她26岁。 珍是
我们家庭、朋友和⽆数粉丝的灯塔，她的光芒将永远照亮我们的⽣活。
珍·哈洛于1937年5⽉下旬突发重病，尽管她的意志坚强，但她的身体⽆法承受。 她的去世是⼀个巨⼤的意外，让我们所有⼈都措⼿
不及。
珍·哈洛在好莱坞留下了不可磨灭的印记，她的才华和美貌令所有⼈着迷。 她是天⽣的明星，她的屏幕魅⼒是⽆与伦⽐的。 从她在
《双响屁》中的突破性⻆⾊到她在《地狱天使》中的标志性表演，珍的天赋是不可否认的。
除了她在银幕上的成就外，珍还是⼀个亲切、善良的灵魂，她的笑声和同情⼼给每个⼈都带来了快乐。 她对她所爱的⼈的奉献是⽆
限的，她的存在将永远被我们铭记。
在这个艰难的时刻，我们请求您尊重我们的隐私，让我们可以在悲伤中相互安慰。 珍将永远活在我们的⼼中，她的精神将永远激励
我们。
感谢您对我们的家⼈和珍的⽣活的关注和爱。
诚挚的，
哈洛家⼈
It's an awkward expression. “在去世后
⼏天内离开了我们” suggests someone 
left after their death, which is 
confusing. The overall wording and 
expression are unnatural which does 
not sound like native speakers in the 
current locale.
Awkward or Unnatural Writing Examples
Locale Example Explanation
zh_CN 除了她在银幕上的成就外，珍还是⼀个亲切、善良的灵魂。
Response: 
好莱坞，加利福尼亚州——1937年6⽉9⽇，我们深感悲痛地宣布，我们⼼爱的珍·哈洛在去世后⼏天内离开了我们。 她26岁。
珍是我们家庭、朋友和⽆数粉丝的灯塔，她的光芒将永远照亮我们的⽣活。
珍·哈洛于1937年5⽉下旬突发重病，尽管她的意志坚强，但她的身体⽆法承受。 她的去世是⼀个巨⼤的意外，让我们所有⼈都
措⼿不及。
珍·哈洛在好莱坞留下了不可磨灭的印记，她的才华和美貌令所有⼈着迷。 她是天⽣的明星，她的屏幕魅⼒是⽆与伦⽐的。 从
她在《双响屁》中的突破性⻆⾊到她在《地狱天使》中的标志性表演，珍的天赋是不可否认的。
除了她在银幕上的成就外，珍还是⼀个亲切、善良的灵魂，她的笑声和同情⼼给每个⼈都带来了快乐。 她对她所爱的⼈的奉献
是⽆限的，她的存在将永远被我们铭记。
在这个艰难的时刻，我们请求您尊重我们的隐私，让我们可以在悲伤中相互安慰。 珍将永远活在我们的⼼中，她的精神将永远
激励我们。
感谢您对我们的家⼈和珍的⽣活的关注和爱。
诚挚的，
哈洛家⼈
It's an unnatural expression in Chinese. In 
our locale, we don't describe someone 
"is"/"是" a soul.
Awkward or Unnatural Writing Examples
Locale Example Explanation
de_DE Er machte sich Zeit für uns, bot Ratschläge und war ein geduldiger Zuhörer. 
Response: 
Mr. Johnson, mein Highschool-Englischlehrer, hatte einen bleibenden Einfluss auf mein Leben. Er war mehr als nur ein Lehrer; er war ein Mentor und 
Inspirator, der mich ermutigte, mein Potenzial auszuschöpfen und härter zu arbeiten. 
Seine Begeisterung für Literatur war ansteckend, und er vermittelte jedes Thema mit echter Leidenschaft. Er ermutigte uns, über die Texte hinaus zu 
denken und ihre tieferen Bedeutungen zu erforschen, was meine Liebe zum Lesen und Schreiben entfachte. Er lehrte mich nicht nur Englisch, sondern 
auch, wie man kritisch denkt, vernünftig kommuniziert und meine Gedanken und Gefühle ausdrückt. 
Eines der bemerkenswertesten Dinge an Mr. Johnson war seine Fähigkeit, das Potenzial in jedem Schüler zu erkennen. Er glaubte an uns, auch wenn wir 
selbst nicht an uns glaubten. Er erinnerte mich ständig daran, dass ich die Fähigkeit hatte, große Dinge zu erreichen, wenn ich bereit war, mir die Mühe 
zu machen. Sein Vertrauen in mich gab mir den Selbstvertrauen, Herausforderungen anzunehmen und mich außerhalb meiner Komfortzone zu wagen. 
Mr. Johnson lehrte mich auch wichtige Lebenslektionen über Disziplin, Hingabe und harte Arbeit. Er erwartete von uns das Beste und akzeptierte nichts 
weniger. Seine Anforderungen zwangen mich, mich anzustrengen und mein volles Potenzial auszuschöpfen, was mir bei allen meinen zukünftigen 
Unternehmungen zugute kam. Ich bin ihm für die Hingabe und das Engagement dankbar, die er mir beigebracht hat, da sie mich zu dem Menschen 
gemacht haben, der ich heute bin. 
Seine Mentorschaft ging über den Klassenzimmer hinaus. Er machte sich Zeit für uns, bot Ratschläge und war ein geduldiger Zuhörer. Er kümmerte sich 
wirklich um das Wohlbefinden und die Zukunft seiner Schüler. Er hatte einen bleibenden Einfluss auf mein Leben, und ich bin ihm für seine 
unerschütterliche Unterstützung und seinen Glauben an mich dankbar. 
Mr. Johnson, mein Highschool-Englischlehrer, inspirierte mich, mein Bestes zu geben und mein Potenzial auszuschöpfen. Ich bin dankbar für seine 
Anleitung, seine Inspiration und seine unerschütterliche Hingabe. Er hat mich auf eine Weise geprägt, die ich nie hätte vorhersehen können, und ich 
werde ihn für den Rest meines Lebens für seine Rolle bei meinem Erfolg schätzen.
"Er machte sich Zeit für 
uns" sounds unnatural/not 
appropriate, the correct 
expression is "Er nahm 
sich Zeit für uns".
Awkward or Unnatural Writing Examples
Locale Example Explanation
de_DE Sie könnten Ihre Reise in Florenz beginnen, der Hauptstadt der Toskana und Heimat vieler kultureller Schätze wie den Dom, die Uffizien und 
die Ponte Vecchio. Von dort aus könntest du Tagesausflüge in Städte wie Siena, Pisa, Lucca und San Gimignano machen, die alle innerhalb 
einer Stunde mit dem Zug oder Auto erreichbar sind. 
Response: 
Sicher! Eine großartige Region in Italien, die perfekt für eine Woche voller Städtetrips ist, ist die Toskana. Die Toskana ist bekannt für ihre 
atemberaubende Landschaft, ihre historischen Städte und ihre exzellente Küche. 
Sie könnten Ihre Reise in Florenz beginnen, der Hauptstadt der Toskana und Heimat vieler kultureller Schätze wie den Dom, die Uffizien und 
die Ponte Vecchio. Von dort aus könntest du Tagesausflüge in Städte wie Siena, Pisa, Lucca und San Gimignano machen, die alle innerhalb 
einer Stunde mit dem Zug oder Auto erreichbar sind. 
Jede dieser Städte hat ihren eigenen einzigartigen Charme und bietet eine Fülle von Sehenswürdigkeiten, Kunst, Architektur und 
Gastronomie. Du könntest auch die malerische Landschaft der Toskana erkunden, Weinproben machen und die Ruhe und Schönheit der 
Region genießen. 
Die Toskana ist eine perfekte Region für eine Woche voller Städtetrips, ohne zu weit fahren zu müssen, und bietet eine unvergessliche 
Reiseerfahrung. Viel Spaß bei deiner Reise!
Inconsistent use of personal 
pronouns. In the first sentence 
the formal pronoun "Sie" is 
used, whereas in the second 
sentence uses the informal 
"du".
Awkward or Unnatural Writing Examples
Locale Example Explanation
it_IT Response:"Ecco un esempio di curiosità in politica:"Qual è la durata più lunga di un 
presidente degli Stati Uniti?"
Although one can intuitively understand the meaning of the sentence, the 
expression "La durata più lunga" does not really make sense in this context, or it 
could even lead to a double entendre.Suggestion (optional) --> It would be more 
correct to say "Quale presidente ha occupato la carica più a lungo nella storia 
degli Stati Uniti?" or "Qual è stata la presidenza più duratura nella storia degli Stati 
Uniti d'America?"
it_IT Response:Come modello di linguaggio AI, non ho accesso ai link ipertestuali o ai 
documenti che stanno fuori, come il foglio di calcolo Google che hai menzionato. Tuttavia, 
se puoi fornirmi i numeri delle colonne 1 e 3, posso calcolare le loro medie e determinare 
se la media dei numeri nella terza colonna è maggiore della media dei numeri nella prima 
colonna.
"che stanno fuori" is not a correct expression in this case, as it is too literal.In 
Italian the correct acronym for "Artificial Intelligence" would be IA ("Intelligenza 
Artificiale") and swapping the words sounds awkward. However the English 
acronym is largely used in this type of context, so there is no need to flag this as a 
localisation issue.
Awkward or Unnatural Writing Examples
Locale Example Explanation
ko_KR 생활습관
Response: 
그런 생각을 하시는 것 같아요. 하지만 우리는 과거를 바꿀 수 없지만, 미래를 더 나은 방향으로 바꿀 수는 있어요. 기억력을 향상시키기 위해 노력하고, 새로운 기
억을 만들어 가는 것도 좋은 방법일 거예요. 또한, 건강한 생활습관과 정기적인 운동, 영양 균형 잡힌 식사도 기억력 향상에 도움이 될 수 있어요. 계속해서 노력하
고, 기억력을 향상시키는 방법을 찾아보세요!
It should be 생활[]습관 as per 
dictionary.
ko_KR 다음과 같습니다:
Response: 
이염은 어린이에게 흔한 건강 문제 중 하나입니다. 이염의 증상은 어린이에게서 빠르게 나타날 수 있으며, 다음과 같습니다: 
1. 특히 누워 있을 때 귀가 아프고, 
2. 귀를 잡아당기거나 당기기
3. 잠들기 어려움
4. 평소보다 더 많이 울고, 까다로움
5. 청각이나 소리에 반응하는 것이 어렵습니다. 
6. 균형 상실
7. 100 F (38 C) 이상의 발열
8. 귀에서 액체 배수
9. 두통
10. 식욕 감퇴
이염은 어린이의 건강에 영향을 미칠 수 있으므로 증상이 나타나면 즉시 의사에게 상담하는 것이 좋습니다.
Wrong punctuation used. It 
should be 다음과 같습니다. (full 
stop)
Formatting and Punctuation Issues Examples (back to Content >>)
Locale Example Explanation
ko_KR 방법이 있습니다:
Response: 
물론이죠, 여기 식 (1 - cos(2a) + sin(2a))/ (1 + cos(2a) + sin(2a))의 0을 찾는 방법이 있습니다: 
이 식을 제로로 만드는 것은 쌍곡선 함수의 쌍곡선 정체성을 사용하여 더 쉽게 할 수 있다. 
먼저, 다음을 기억하세요: 
코사인(2a) = 2코사인^2(a) - 1 
시인(2a) = 2시인(a) * 코사인(a) 
그런 다음 원래 방정식에 대입하면: 
(1 - (2cos^2(a) - 1) + 2sin(a) * cos(a))/ (1 + (2cos^2(a) - 1) + 2sin(a) * cos(a)) 
= (2cos^2(a) - 1 + 2sin(a) * 코사인(a))/ (2cos^2(a) - 1 + 2sin(a) * 코사인(a) + 1) 
= (2cos^2(a) + 2sin(a) * 코사인(a) - 1 + 2sin(a) * 코사인(a))/ (2cos^2(a) + 2sin(a) * 코사인(a) - 1 + 1) 
= (4sin(a) * 코사인(a))/ (2cos^2(a) + 2sin(a) * 코사인(a) - 0) 
= 2sin(a) * 코사인(a)/ (cos^2(a) + sin(a) * 코사인(a)) 
이제, 우리는 다음을 사용하여 이것을 더 단순화할 수 있다: 
코사인^2(a) + 시인^2(a) = 1 
(2sin(a) * 코사인(a))/ (cos^2(a) + sin(a) * 코사인(a)) = 
(2sin(a) * 코사인(a))/ (1 - sin^2(a)) 
= 2sin(a) * 코사인(a)/ 코사인(a) 
= 2sin(a) 
따라서, 원래 방정식은 2sin(a) = 0일 때 0이 된다. 
이것은 sin(a) = 0 또는 sin(a) = 0의 두 가지 가능한 해결책을 가진다는 것을 의미한다. 
시인(a) = 0은 a = 0, 3π/2, 2π, 5π/2, ...과 같은 a의 모든 짝수 곱에 해당한다. 
코사인(a) = 0은 a = π/2, 3π/2, 5π/2, ...과 같은 a의 모든 짝수 곱에 해당한다. 
따라서, 원래 방정식의 0은 a = 0, π/2, 3π/2, ...과 같은 a의 모든 짝수 곱이다.
Colon is used instead of period 
at the end of the sentences.
Formatting and Punctuation Examples
Locale Example Explanation
es_ES "Esoterismo eslavo" o "Rodnoverie" (...) "upyrs" 
Response: 
"La teoría de conspiración que usted mencionó parece estar relacionada con un movimiento conocido como "Esoterismo eslavo" o 
"Rodnoverie" (Nativo de la fe), que es una forma de neopaganismo que se ha desarrollado en Rusia y otros países de la antigua Unión 
Soviética. Este movimiento busca revivir y reconstruir las antiguas creencias y prácticas paganas de los pueblos eslavos antes de su 
conversión al cristianismo. 
Según algunas de las creencias dentro del Rodnoverie, los antiguos eslavos adoraban a una serie de dioses y diosas, y creían en una fuerza 
cósmica llamada "Rod" que gobernaba el universo. También creían que existían seres malignos, como los "upyrs" o vampiros, y los "lichy", 
que eran criaturas similares a los lagartos que eran vistos como enemigos de los eslavos. 
En la teoría de conspiración que su estudiante le mencionó, parece que se combinan estos elementos para crear una historia en la que los 
rusos lucharon contra una raza de personas lagarto que intentaban tomar sus tierras. Se dice que los rusos bebieron del lago Baikal, que les 
otorgó poderes de los antiguos dioses eslavos, y que así fueron capaces de derrotar a estas criaturas y proteger su tierra. 
Es importante destacar que esta teoría de conspiración no tiene ningún respaldo histórico y es vista como una creencia marginal dentro de 
la comunidad académica. La historia y la cultura de los rusos es un tema ampliamente estudiado y documentado, y no hay ninguna 
evidencia que respalde la existencia de una raza de personas lagarto o de cualquier batalla de este tipo. 
En resumen, aunque puede ser interesante aprender sobre las diferentes creencias y prácticas religiosas de los pueblos eslavos, es 
importante tener en cuenta que las teorías de conspiración sin respaldo histórico deben ser tratadas con escepticismo y analizadas 
críticamente antes de ser aceptadas como ciertas."
The assistant tends to use 
English quotation marks ( " " ). 
The correct quotation marks in 
Spanish are the guillemets ( « » 
). English quotation marks 
should only be used inside 
guillemets.
Formatting and Punctuation Examples
Locale Example Explanation
fr_FR Slide 3: Amélioration de la santé cardiovasculaire 
Response: 
Malheureusement, je ne peux pas créer une présentation directement dans Google Slides. Cependant, voici un exemple de plan que vous 
pourriez suivre pour créer votre propre présentation sur les bienfaits de l'activité physique régulière sur la santé : 
Slide 1: Titre - Les bienfaits de l'activité physique régulière sur la santé 
Slide 2: Introduction - Définition de l'activité physique régulière et son importance pour la santé 
Slide 3: Amélioration de la santé cardiovasculaire 
Slide 4: Renforcement des muscles et des os 
Slide 5: Contrôle du poids 
Slide 6: Réduction du risque de maladies chroniques (diabète, cancer, etc.) 
Slide 7: Amélioration de la santé mentale et du bien-être 
Slide 8: Recommandations pour une pratique sportive régulière 
Slide 9: Conclusion - Résumé des bienfaits de l'activité physique régulière sur la santé 
N'oubliez pas d'ajouter des images, des graphiques et des chiffres pour illustrer les différents points et rendre votre présentation plus 
dynamique. Bonne création !
This is not a big issue as French 
is not extremely strict with 
typographical variants. 
However, the correct 
typography for French 
formatting would be to add 
spacings on both sides of a 
colon.
Formatting and Punctuation Examples
Locale Example Explanation
fr_FR C'est comme un jeu de mots dans lequel "la précision" et "la brièveté" sont vos meilleurs amis. 
Response: 
Titre : "The (Not So) Secret Diary of a New Lawyer : 10 Things I Wish I Knew Before Becoming a Lawyer" 
Cher lecteur, 
Bienvenue dans le monde trépidant de l'avocature ! Où les rêves de porter des costumes à trois pièces et de défendre la justice dans des 
salles d'audience comme Perry Mason se heurtent rapidement à la réalité de la rédaction de documents juridiques et de la recherche de 
documents dans des fichiers de cour. En tant que diplômé récent de la faculté de droit qui a traversé le feu, je suis là pour partager les 10 
choses que j'aurais aimé savoir avant de devenir avocat. Alors, attachez vos ceintures de sécurité, et préparez-vous pour un voyage hilarant 
et éclairant. 
1 Le talent de la rédaction est un super pouvoir : 
Vous avez peut-être excellé dans vos cours de droit, mais laissez-moi vous dire que la rédaction de documents juridiques est une 
compétence tout à fait différente. C'est comme un jeu de mots dans lequel "la précision" et "la brièveté" sont vos meilleurs amis. Préparezvous à transformer vos phrases complexes en paragraphes clairs et concis qui pourraient endormir même le professeur le plus agité. Conseil 
: pratiquez la rédaction de notes pour vous-même comme si vous étiez un blogueur juridique, et vous serez un maître de la clarté en aucun 
temps. 
2 La recherche de documents est comme une chasse au trésor : 
Imaginez cela : des piles de documents, des fichiers numériques et des années de procès à fouiller. La recherche de documents est 
l'aventure d'un avocat, et la découverte de la pièce maîtresse du puzzle peut être aussi gratifiante que de trouver la dernière figurine Funko. 
Conseil : développez votre amour pour les mots-clés et ne soyez pas intimidé par les piles de documents. Vous serez un détective de 
documents en un rien de temps. 
[continued on the next slide] ->>
The assistant always uses 
English quotation marks ( " " ). 
Like Spanish, the traditional 
quotation marks in French are 
the guillemets ( « » ). However 
note that other types of 
quotation marks, including 
English quotations, may be 
used from time to time, 
depending on the typography 
policy of each organization and 
the style the writer wants to 
give to its document. 
- for each paragraph number, 
we would add a bullet point 
after each number (e.g. "1. Le 
talent de la rédaction est un 
super pouvoir :") 
Formatting and Punctuation Examples
Locale Example Explanation
fr_FR [beginning on the previous slide] 
3 L'art de la négociation est une danse comme aucune autre : 
La négociation est plus qu'une simple transaction ; c'est une danse de la persuasion. Vous devez être capable de lire entre les lignes, de comprendre 
les besoins de votre client et de trouver un terrain d'entente. C'est comme une partie de poker où votre visage impassible est votre atout. Conseil : 
écoutez attentivement, soyez empathique et ne soyez pas intimidé par les échanges de piques. Vous apprendrez bientôt à naviguer dans les 
négociations comme un pro. 
4 La patience est une vertu : 
Le système judiciaire peut être aussi lent qu'une tortue en hiver, et parfois, il semble que la justice ne soit pas à portée de main. Apprenez à être 
patient et à faire confiance au processus. C'est comme attendre que votre commande de café prenne bien trop longtemps, mais au moins, vous 
n'avez pas à vous soucier que quelqu'un soit accusé à tort. Conseil : adoptez un mantra de patience et faites des activités relaxantes pour vous aider 
à rester calme. La méditation ou le cri peuvent fonctionner. 
5 Le réseautage est la clé : 
Cela peut sembler impoli, mais construire des relations dans le domaine juridique peut ouvrir de nombreuses portes. Assistez à des événements, 
rejoignez des associations et devenez un membre actif de la communauté juridique. C'est comme aller à une fête où tout le monde porte des 
costumes, et vous devez vous souvenir de tous les noms. Conseil : soyez vous-même, établissez des liens authentiques et n'oubliez pas d'apporter 
vos cartes de visite. 
6ème Le stress est un compagnon constant : 
Les hauts et les bas de la profession juridique peuvent être stressants, mais il est essentiel de trouver un équilibre entre le travail et la vie 
personnelle. C'est comme essayer de garder une assiette sur une perche tout en jonglant avec d'autres. Conseil : fait
Formatting and Punctuation Examples
Locale Example Explanation
pt_Br Response: 
"Eu. Introdução 
A. Visão geral da Comissão e sua jurisdição sobre as Regras de Segurança de Chamadas de Telemarketing (TSR). 
B. Descrição das duas alterações de última hora propostas para o TSR. 
II Primeira Emenda: Proibição de Chamadas de Telemarketing com Mensagens Pré-gravadas sem Consentimento 
Um. Exposição do problema: Chamadas de telemarketing com mensagens pré-gravadas sem consentimento explícito 
b. Conteúdo da emenda: Proibição explícita de chamadas de telemarketing com mensagens pré-gravadas sem consentimento 
prévio por escrito 
C. Justificativa: Considerações do consumidor razoável e respeito pelo direito à privacidade 
D. Implicações para as empresas de telemarketing: necessidade de ajustar os processos e obter consentimentos por escrito 
III Segunda Emenda: Revisão do Método de Medição da Taxa de Abandono de Chamadas 
Um. Exposição do problema: limitação do método atual de medição da taxa de abandono de chamadas 
B. Conteúdo da emenda: Permitir a medição da taxa de abandono de chamadas em um período de 30 dias ou qualquer parte 
dele 
C. Justificativa: Ajuste para acomodar discadores preditivos com pequenas listas de chamadas e melhorar a flexibilidade 
D. Implicações para os vendedores e operadores de telemarketing: capacidade de otimizar as campanhas de chamadas ao vivo 
e uso mais eficaz dos discadores preditivos 
iv. Conclusão 
A. Resumo das alterações aprovadas no TSR 
B. Enfatizando a importância de proteger os direitos dos consumidores e promover práticas éticas no setor de telemarketing 
C. Encerrando com uma visão geral do processo futuro de implementação das emendas.“
The headings have errors in formatting. 
For instance, chapter "Introdução" has the word 
"Eu" in capital letters instead of the roman 
numeral one (I). The system translated the roman 
numeral as if it was the pronoun "I", which in 
Portuguese is "Eu" (first person of the singular). 
In addition to that, the second chapter has two 
formatting problems. 1) The word "um" was 
wrongly added instead of the letter "A" to 
separate the sub-items. 2) The letter B is written 
in lowercase and it should be capitalized like the 
other sub-items. 
Finally, the fourth chapter "Conclusão" has the 
roman numeral in lowercase, while it should have 
been capitalized, "IV" instead of "iv". 
Formatting and Punctuation Examples
Locale Example Explanation
pt_Br "* Carnes cruas ou mal cozidas, ovos, aves, laticínios e sucos não pasteurizados podem conter bactérias que causam infecções 
gastrointestinais."Response: "Aqui estão alguns marcadores de fontes comuns de infecções gastrointestinais bacterianas:* Carnes 
cruas ou mal cozidas, ovos, aves, laticínios e sucos não pasteurizados podem conter bactérias que causam infecções 
gastrointestinais.* Água contaminada pode conter bactérias que causam infecções gastrointestinais.* Alimentos mal refrigerados, 
especialmente carnes e ovos, podem se tornar contaminados por bactérias e causar infecções gastrointestinais.* Frios e frutas e 
vegetais crus ou não lavados podem conter bactérias que causam infecções gastrointestinais.* Indivíduos com infecção 
gastrointestinal bacteriana podem espalhar a bactéria para os alimentos que manipulam, infectando potencialmente outras 
pessoas que consomem os alimentos contaminados.“
In Portuguese, bullet points will 
finish with a semicolon, apart 
from the last one of the list which 
will finish with a full stop.In this 
example, we have a punctuation 
error because all bullet points 
end with a full stop, not following 
correct punctuation for the pt_BR 
locale.
ja_JP Response: 
1。 天体物理学の歴史はヨーロッパのルネサンス時代に始まりました。 
2。 ルネサンスでは、天文学は神話から解放され、科学的探求に適した学問になりました。 
3。 1610年、ガリレオ・ガリレイは望遠鏡を使⽤して天⽂学に⾰命をもたらしました。
4。 ガリレイの発見は、教会の宇宙に関する教えと矛盾しており、紛争につながった。 
5。 1633年、ガリレイはローマの異端審問にかけられ、彼の発⾒を放棄するように強制されました。
6。 彼は1642年に亡くなるまで⾃宅軟禁下に置かれた。
It is not locally appropriate to 
format numbering with the round 
period after the number. 
Although the round period ( 。) is 
used at the end of Japanese 
sentences, regular periods ( . ) 
are used for numbering.
Formatting and Punctuation Examples
Locale Example Explanation
ja_JP Response: 
もちろん！ 数学は、私たちの⽇常⽣活のさまざまな側⾯に深く根付いており、楽しいロードトリップを計画する場合も例外ではありません。 数学がこの活動にどのように影響するかを示すために、
いくつかの興味深い例を次に示します。
1。 旅⾏距離の計算：⽬的地に到達するために必要な総距離を計算するために、三⻆法を使⽤できます。 地球が球体であると仮定すると、地球の半径と⽬的地の緯度と経度の間の⻆度を使⽤して、
旅⾏距離を近似することができます。
2。 燃料消費量の推定：⾞の燃費と旅⾏距離を考慮して、旅⾏中に必要なガソリンの量を計算できます。 これにより、ガソリンスタンドでの停留所を計画し、予算をオーバーランする可能性を減ら
すことができます。
3。 旅の時間の計算：⾞の速度と旅⾏距離を考慮して、⽬的地に到達するのにかかる時間を推定できます。 これにより、休憩や目的地でのアクティビティを効果的に計画することができます。
4。 コストの分割：友達と旅費を分割する必要がある場合は、数学を活用して、各人が支払うべき正確な金額を計算できます。 これは、公平でストレスのない分割を保証します。
5。 最適なルートの決定：複数のルートから⽬的地を選択する場合は、各ルートの距離と時間を⽐較する必要があります。 数学を使⽤して、総旅⾏時間と距離を最⼩化するルートを決定できます。
6。 宿泊施設のコストの計算：宿泊施設の価格を考慮して、旅⾏の期間にわたって宿泊費⽤を計算できます。 これにより、予算内で宿泊を計画し、余分な支出を避けることができます。
7。 観光スポットのアクティビティのスケジューリング：数学を活⽤して、旅⾏期間中に観光スポットを効果的にスケジュールできます。 これにより、すべての魅力を体験しながら、時間を最大限に
活用することができます。
8。 ⻝事のコストの計算：⻝事費を計算することで、旅⾏中の⻝事予算を管理できます。 これにより、さまざまなレストランを試食したり、地元の料理を楽しんだりしながら、予算を守ることがで
きます。
9。 予備の予算の設定：予備費を設定することで、予期せぬ費⽤や予期せぬ機会に備えることができます。 数学を使⽤して、これらの予備費⽤の適切な⾦額を決定できます。
10。 写真の⻆度の計算：写真に美しさと⽐率を加えるために、数学を使⽤して、⾵景や建築物の最適な⻆度を計算できます。 これにより、より印象的な思い出が残る写真になります。
11です。 星座の観測：天⽂学に興味がある場合は、数学を使⽤して夜空の星座を特定することができます。 星座を観測し、その物語や伝説について学ぶことは、ロードトリップの魅惑的な追加にな
ることができます。
これらは、数学が楽しいロードトリップを計画する上で果たす役割のほんの一例です。 数学は、私たちの周りの世界を理解し、私たちの⽇常⽣活のさまざまな側⾯を最適化するための強⼒なツール
です。
It is not locally 
appropriate to format 
numbering with the 
round period after the 
number. 
Although the round 
period ( 。) is used at 
the end of Japanese 
sentences, regular 
periods ( . ) are used 
for numbering.
Formatting and Punctuation Examples
Locale Example Explanation
zh_CN 1。 ⻓期债务周期
Response: 
债务周期是指公司通过借贷和偿还债务来管理其财务义务的时间。 根据其偿还期限，债务周期可以分为⻓期债务周期和短期债务周期。
1。 ⻓期债务周期：
⻓期债务周期涉及公司为超过⼀年期限的财务承诺筹集资⾦。 这些债务通常以固定利率提供，并要求定期还款，通常为每年或每五年。 常⻅的⻓期债务⼯具
包括：
1。 公司债券：公司债券是公司向投资者发⾏的债务证券。 这些债券承诺在未来特定⽇期⽀付固定利率的定期利息，以及到期时归还原始⾯额。
2。 ⻓期贷款：公司可以从银⾏或其他⾦融机构获得⻓期贷款，以满⾜其⻓期资⾦需求。 这些贷款可以有固定或浮动利率，并要求在⼀定期限内进⾏还款，
通常为5年到25年。
3。 租赁承诺：租赁承诺允许公司租赁资产，如设备或⻋辆，在租赁期内⽀付固定的租⾦。 虽然租赁承诺不像债务⼀样会出现在公司的资产负债表上，但它
们具有类似的财务影响，因为它们承担了公司在租赁期内的⻓期财务义务。
2。 短期债务周期：
短期债务周期涉及公司为⼀年或更短的期限筹集资⾦。 这些债务通常以浮动利率提供，并要求在短期内还款，通常为30天⾄12个⽉。 常⻅的短期债务⼯具包
括：
1。 商业票据：商业票据是公司向供应商或其他公司发⾏的短期债务证券。 它们承诺在到期时以折扣价归还原始⾯额。 商业票据通常⽤于管理公司的流动资
⾦需求。
2。 短期贷款：公司可以从银⾏或其他⾦融机构获得短期贷款，以满⾜其短期资⾦需求。 这些贷款通常有较短的到期期限，从⼏天到⼀年不等，并可能具有
浮动利率，以适应市场条件的变化。
3。 存款：公司可以将资⾦存⼊银⾏，以获得短期利息收⼊。 虽然这些存款不是债务，但它们可以作为公司管理短期流动资⾦的⼯具。
总之，⻓期债务周期涉及为超过⼀年期限的财务承诺筹集资⾦，⽽短期债务周期涉及为⼀年或更短的期限筹集资⾦。 每个债务周期都有其独特的⻛险和回报
特征，公司根据其财务⽬标和可⽤性来决定使⽤哪种债务⼯具。
For number list format, the 
punctuation after each number 
should be western full stop "." 
instead of Chinese full stop "。".
Formatting and Punctuation Examples
Locale Example Explanation
zh_CN 答案： 亚喀巴湾突然发⽣了⿊海胆⼤规模死亡事件，这可能会导致当地⽣态系统发⽣变化。
Response: 
问题：亚喀巴湾突然发⽣了什么可能会导致当地⽣态系统发⽣变化的事情？
答案： 亚喀巴湾突然发⽣了⿊海胆⼤规模死亡事件，这可能会导致当地⽣态系统发⽣变化。⿊海胆是⼀种重要的底栖⽣物，它们可以帮
助控制藻类的⽣⻓，保护珊瑚礁免受侵蚀。⿊海胆的⼤规模死亡会导致藻类的过度⽣⻓，从⽽威胁到珊瑚礁的⽣存。此外，⿊海胆的死
亡还会导致其他栖息在珊瑚礁中的⽣物⾯临⻝物短缺和栖息地丧失的问题，这可能会进⼀步影响当地⽣态系统的平衡。
因此，亚喀巴湾⿊海胆⼤规模死亡事件需要引起重视，进⼀步调查其原因和后果，采取措施保护和恢复当地⽣态系统。
There is an extra space after the 
Chinese colon, which is a full-width 
punctuation mark.
Formatting and Punctuation Examples
Locale Example Explanation
de_DE 1. Finanzierung der Hochschulausbildung der Kinder, das Kauf eines Hauses oder die Erreichung eines bestimmten Sparziels. 
2. Erstellen Sie ein Testament oder ein Trust, um Ihre Vermögenswerte zu regeln. 
3. Hier ist eine Microsoft Word Checkliste für einen Finanzplan mit den von Ihnen angeforderten Kategorien 
Response: 
Hier ist eine Microsoft Word Checkliste für einen Finanzplan mit den von Ihnen angeforderten Kategorien: 
## Finanzplan-Checkliste 
1 Notfallplanung: 
- Bestimmen Sie Ihre Notfallziele und die entsprechenden Beträge. 
- Bewerten Sie Ihren aktuellen Notfallsparbestand und die erforderliche Sparrate. 
- Richten Sie ein Notfallsparguthaben ein und halten Sie es auf dem neuesten Stand. 
- Überprüfen und aktualisieren Sie regelmäßig Ihre Notfallziele und -sparpläne. 
2. Entschuldung: 
- Entwickeln Sie einen Entschuldungsplan, um Ihre Schulden zu eliminieren. 
- Listen Sie Ihre Schulden mit dem Fälligkeitsdatum, dem Zinssatz und der Höhe auf. 
- Priorisieren Sie Ihre Schulden mit Strategien wie dem Schneeflockenprinzip oder dem hohen Zinsen zuerst. 
- Weisen Sie monatliche Zahlungen zu und überwachen Sie den Fortschritt Ihrer Schuldenabzahlung. 
3 Pläne für den Ruhestand machen: 
- Bestimmen Sie Ihre gewünschten Ruhestandsziele und die erforderlichen Beträge. 
- Bewerten Sie Ihren aktuellen Ruhestandsparbestand und die erforderliche Sparrate. 
- Richten Sie einen Ruhestandssparplan ein und halten Sie ihn auf dem neuesten Stand. 
Überprüfen und aktualisieren Sie regelmäßig Ihre Ruhestandsziele und -sparpläne. 
[continued on the next slide] ->>
1. Wrong gender: ’Das Kauf eines Hauses’
should be ‘den Kauf eines Hauses’. 
2. Wrong gender: ‘ein Trust’ should be 
‘einen Trust’. 
3. Microsoft Word Checkliste’ is a 
compound word that should be 
hyphenated according to German 
grammar rules.
Formatting and Punctuation Examples
Locale Example Explanation
de_DE [beginning on the previous slide] 
4 Nachfolgeplanung: 
- Bestimmen Sie Ihre Nachfolgeziele und die entsprechenden Dokumente. 
- Erstellen Sie ein Testament oder ein Trust, um Ihre Vermögenswerte zu regeln. 
- Ernennen Sie Vormünder für minderjährige Kinder. 
- Teilen Sie Ihre Nachfolgepläne mit Ihren Lieben mit. 
5 Andere finanzielle Ziele: 
- Listen Sie Ihre anderen finanziellen Ziele auf, wie z. B. die Finanzierung der Hochschulausbildung der Kinder, das Kauf eines Hauses 
oder die Erreichung eines bestimmten Sparziels. 
- Bestimmen Sie die erforderlichen Beträge und Fristen für jeden Ziele. 
- Entwickeln Sie Pläne, um diese Ziele zu erreichen, und überwachen Sie regelmäßig ihren Fortschritt. 
Allgemein: 
- Überprüfen Sie regelmäßig Ihren Finanzplan und aktualisieren Sie ihn bei Bedarf. 
- Berücksichtigen Sie Änderungen Ihrer Lebensumstände, Ziele oder Marktbedingungen. 
- Suchen Sie bei Bedarf die Beratung eines Finanzberaters ein, um Ihre Finanzplanung zu unterstützen. 
Bitte beachten Sie, dass diese Checkliste ein allgemeiner Leitfaden ist und möglicherweise an Ihre spezifischen finanzielle Umstände und 
Ziele angepasst werden muss.
Formatting and Punctuation Examples
Locale Example Explanation
it_IT Response: 
Ecco un elenco di tutti gli ingredienti della ricetta Fusilli con verdure primavera e pangrattato con le loro quantità: 
Copertura della mollica: 
- 1 tazza di pangrattato fresco 
- 1/2 tazza di mandorle a scaglie 
- 1 spicchio d'aglio pressato 
- 1 cucchiaio di burro non salato 
- 1/4 di cucchiaino di sale kosher 
Pasta: 
- 1 chilo di fusilli o altra pasta a spirale 
- 1 mazzetto di asparagi cimati e tagliati a pezzetti di 1 pollice 
- 1/2 tazza di piselli surgelati 
- 2 cucchiai di burro non salato 
- 2 cucchiaini di scorza di limone finemente grattugiata 
- 1 confezione (4 once) di spinaci novelli tritati (circa 4 tazze confezionate) 
- 1/2 cucchiaino di sale kosher 
- 1 vaschetta di mascarpone (8 once) (1/2 tazza) 
Copertura della mollica: 
- Se si usa il pane fresco, rimuovere la crosta e tagliarlo a cubetti, quindi metterlo nella ciotola del robot da cucina e 
frullarlo fino ad avere le briciole. Sarà necessaria 1 tazza. 
- Nello stesso robot, tritare le mandorle in pezzi più piccoli di 1/4 di pollice (in alternativa, tritarle a mano). 
- In una padella grande, riscaldare il burro a fuoco medio. Una volta sciolto aggiungere le briciole, le mandorle, l'aglio 
e il sale. Amalgamare per bene gli ingredienti mentre si scaldano. Cuocere mescolando spesso, fino a quando non 
risulterà dorato e flagrante, per circa 4-6 minuti. Trasferire il tutto in una ciotola media e mettere da parte. 
Nota: la ricetta non include la quantità di pane necessaria per fare 1 tazza di briciole.
Punctuation: 
"Una volta sciolto, aggiungere le briciole, le mandorle, 
l'aglio e il sale." In this case, the comma after the word 
"sciolto" is necessary to highlight and better explain the 
sequence of actions. 
Awkward or unnatural writing: 
"Copertura della mollica". This sentence does not 
convey the correct meaning, as it is the breadcrumbs 
that create the crispy layer, not the layer covering the 
breadcrumbs. 
Units of measurements are not localized: 
1. '1 police' should have been '1.5 cm'2. ' (4 once)’
should have been '113 gr'3. '(8 once)' should have been 
'227 gr'4. '1/4 di police' should have been '6.35 mm'
Formatting and Punctuation Examples
Congratulations! AIML ANNOTATION
You have completed the “Localization Task” guidelines