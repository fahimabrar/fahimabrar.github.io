// Toggle popup open/close
const chatbotToggle = document.getElementById('chatbot-toggle');
const chatbotPopup = document.getElementById('chatbot-popup');

function arrange(val) {
    return atob(val);
}

const API_KEY = "QUl6YVN5QzhZbW9RVkxEdjA1SXVwTFZyODZWaDYzaUhMR2drMzRR";
const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${arrange(API_KEY)}`;


chatbotToggle.addEventListener('click', () => {
  chatbotPopup.classList.toggle('hidden');
});

// Chat functionality
const chatlogs = document.getElementById('chatlogs');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');

function createChat(message, className) {
  const chatDiv = document.createElement('div');
  chatDiv.classList.add('chat', className);

  const userPhoto = document.createElement('img');
  userPhoto.classList.add('user-photo');

  // Set different images for user and bot
  if (className === 'user') {
    userPhoto.src = 'user.png';  // your user's photo file
  } else {
    userPhoto.src = 'bot.png';   // your bot's photo file
  }

  const chatMessage = document.createElement('div');
  chatMessage.classList.add('chat-message');
  chatMessage.textContent = message;

  chatDiv.appendChild(userPhoto);
  chatDiv.appendChild(chatMessage);
  chatlogs.appendChild(chatDiv);

  chatlogs.scrollTop = chatlogs.scrollHeight;
}

async function botResponse(input) {
  // Prepare the data to send to the Gemini API
  const data = {
    contents: [{
      parts: [{
        text: `Based in London, Abrar Fahim is a dynamic Data Scientist with over three years of experience specializing in the Healthcare and Fintech industries. His work focuses on building Large Language Model (LLM)-based solutions tailored to diverse user needs, with expertise in fine-tuning models, advanced Retrieval-Augmented Generation (RAG), emotion detection in large texts, and domain-specific LLM adaptation.

Abrar currently leads innovation at HecoAnalytics, where he has developed cutting-edge AI tools that dramatically streamline health economists' literature reviews, slashing timelines from eight weeks to just two. His projects span a sophisticated desktop application for precise text generation, an AI meeting summarizer for dynamic reporting, and an emotion analyzer gauging public sentiment on COVID-related news. His work consistently achieves top-tier benchmarks, including BERTScores above 0.83.

Previously, at Brunel University London in collaboration with Advanced Logic Analytics, Abrar spearheaded the development of a stock market behavior observation tool. Leveraging millions of financial news articles, he enhanced the understanding of market reactions to emotional narratives, offering predictive insights into stock volatility.

Early in his career at CityMaas, Abrar contributed to greater accessibility by developing an image captioning model to assist users with disabilities—work that also earned him an A+ for his MSc dissertation at Brunel University London. He holds a BSc in Computer Science and Engineering from North South University.

In addition to his industry work, Abrar has demonstrated strong research acumen. He authored a publication on refugee population estimation using deep learning in the *Vietnam Journal of Computer Science*. His entrepreneurial spirit is reflected in projects like Verbix AI, where he developed a semantic movie search engine and an intelligent CV analyzer, among other LLM-powered applications.

Abrar’s technical toolkit includes HuggingFace, TensorFlow, PyTorch, AWS services (SageMaker, Bedrock), LangChain, and more. He also holds certifications in Management and Leadership (CMI Level 5), Bloomberg Market Concepts, and Generative AI specialization from Coursera.

Recognized for his exceptional talent, Abrar was awarded the prestigious UK Global Talent Visa endorsed by UKRI, enabling him to continue pioneering data science innovation in the United Kingdom.

\nUse above information act as a chatbot, and reply to this user query with single line :\n\n${input}`
      }]
    }]
  };

  try {
    // Call the Gemini API to get the summary
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error('API request failed');
    }

    // Get the response JSON
    const result = await response.json();
    console.log(result);

    // Safely access the text from the response
    const summary = result.candidates?.[0]?.content?.parts?.[0]?.text || 'No summary available';
    return summary;

  } catch (error) {
    console.error("Error occurred:", error);
    return 'Error occurred while processing the request.';
  }
}


chatForm.addEventListener('submit', function(event) {
  event.preventDefault();
  const input = userInput.value.trim();
  if (input) {
    createChat(input, 'user');
    setTimeout(async () => { // <--- make this async!
      const response = await botResponse(input); // now await will work
      createChat(response, 'bot');
    }, 500);
    userInput.value = '';
  }
});
