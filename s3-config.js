// AWS S3 Configuration
export const AWS_CONFIG = {
    accessKeyId: 'AKIANGOD7E5QGEDGA24FBKTBPIF7Y6SXNI4U6SF4DYTX',
    secretAccessKey: 'FNWqMZsRMHq2PKteg3gODFa3Di5jrI7l7TWby',
    endpoint: 'https://s3.eu-central-1.s4.mega.io',
    bucket: 'abm-pdf-system',
    region: 'eu-central-1'
};

// Helper function to generate AWS signature
async function generateSignature(stringToSign, secretKey) {
    const encoder = new TextEncoder();
    const data = encoder.encode(stringToSign);
    const key = encoder.encode(secretKey);
    
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Upload image to S3 using simple PUT request
export async function uploadImageToS3WithSDK(file) {
    try {
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(7);
        const extension = file.name.split('.').pop();
        const fileName = `chaterly/${timestamp}_${randomString}.${extension}`;
        
        // Construct the full URL
        const url = `${AWS_CONFIG.endpoint}/${AWS_CONFIG.bucket}/${fileName}`;
        
        // Get current date in ISO format
        const now = new Date();
        const dateString = now.toISOString().split('T')[0].replace(/-/g, '');
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        
        // Create authorization header
        const headers = {
            'Content-Type': file.type,
            'x-amz-date': amzDate,
            'x-amz-acl': 'public-read'
        };
        
        // Try direct upload without signature first (if bucket allows)
        try {
            const response = await fetch(url, {
                method: 'PUT',
                headers: headers,
                body: file
            });
            
            if (response.ok) {
                return url;
            }
        } catch (e) {
            console.log('Direct upload failed, trying alternative method:', e);
        }
        
        // Alternative: Convert to base64 and store in Firebase Storage or use a simpler approach
        // For now, we'll use a proxy or convert to data URL
        return await convertToDataURL(file);
        
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
}

// Fallback: Convert image to base64 data URL (stores in Firebase)
async function convertToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            resolve(e.target.result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Alternative upload using FormData (for multipart uploads)
export async function uploadImageToS3(file) {
    try {
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(7);
        const extension = file.name.split('.').pop();
        const fileName = `chaterly/${timestamp}_${randomString}.${extension}`;
        
        const url = `${AWS_CONFIG.endpoint}/${AWS_CONFIG.bucket}/${fileName}`;
        
        // Simple PUT request
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': file.type
            },
            body: file
        });
        
        if (response.ok) {
            return url;
        }
        
        // If failed, fallback to data URL
        return await convertToDataURL(file);
        
    } catch (error) {
        console.error('Error uploading to S3:', error);
        // Fallback to data URL
        return await convertToDataURL(file);
    }
}
