import io
import re
import xml.etree.ElementTree as ET
from PIL import Image

SAFE_ICON_NAME = re.compile(r'^[0-9a-f]{64}\.(png|svg)$')


def validate_icon(content: bytes, filename: str) -> tuple[bytes, str, str]:
    if not content or len(content) > 2_000_000:
        raise ValueError('Icon must contain 1..2000000 bytes')
    if filename.lower().endswith('.svg'):
        text = content.decode('utf-8-sig')
        if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
            raise ValueError('SVG declarations are not allowed')
        root = ET.fromstring(text)
        tags = {'svg', 'g', 'defs', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
                'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'symbol'}
        if root.tag.split('}')[-1] != 'svg': raise ValueError('Expected SVG root')
        for node in root.iter():
            if node.tag.split('}')[-1] not in tags: raise ValueError('Unsupported SVG element')
            for key, value in node.attrib.items():
                key = key.split('}')[-1].lower()
                if key.startswith('on') or (key == 'href' and not value.startswith('#')) or ('url(' in value.lower() and not re.fullmatch(r'url\(#[\w-]+\)', value)):
                    raise ValueError('Active or external SVG content is not allowed')
        return ET.tostring(root, encoding='utf-8'), '.svg', 'image/svg+xml'
    with Image.open(io.BytesIO(content)) as image:
        if image.format not in {'PNG', 'JPEG', 'WEBP', 'GIF', 'ICO'} or image.width > 2048 or image.height > 2048:
            raise ValueError('Unsupported icon format or dimensions')
        image.load()
        output = io.BytesIO()
        image.convert('RGBA').save(output, format='PNG')
    return output.getvalue(), '.png', 'image/png'
